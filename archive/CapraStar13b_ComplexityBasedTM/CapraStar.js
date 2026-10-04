import { BoardUtil } from "../BoardUtil.js";
import { BBUtil } from "../BBUtil.js";
import { Piece } from "../Piece.js";
import { Move } from "../Move.js";
import { white, black, none, pawn, knight, bishop, rook, queen, king, enPassantFlag } from "../Constants.js";
import { MoveGenerator } from "../MoveGenerator.js";

/* 🐐 CapraStar - The Greatest of All Tactics 🐐 */
/* This bot will for sure checkmaaaaate you */
//CapraStar
//V 13b

const DEFAULT_YIELD_EVERY_NODES = 2048;
//CapraStar bot implementation
class SearchTimeout extends Error {}

export class CapraStar {
  constructor(board) {
    this.board = board;
    this.moveGen = new MoveGenerator();
    this.initialize(); //Contains constants the bot uses like piece-square tables, etc

    this.searchDeadline = Infinity;
    this.searchSoftDeadline = Infinity;
    this.timeManagement = null;
    this.maxNodes = Infinity;
    this.nodesSearched = 0;
    this.searchCancelled = false;
    // Yield frequently enough to process cancellation/new-position messages,
    // while keeping the overhead negligible relative to a search node.
    this.yieldEveryNodes = DEFAULT_YIELD_EVERY_NODES;
    //Holds the best move found on every turn
    this.bestMoveFound = 0;
    //Holds the evaluation of the current position after a search
    this.evaluation = 0;
    //Max depth on the current search
    this.maxDepthReached = 0;
    //Holds the current principal variation after a search (list of best moves for either side up to a certain depth)
    this.principalVariation = [];
    // Number of occurrences of each position on the played/search line.
    this.repetitionCounts = new Map();
    this.openingBook = {};
  }

  getBookMove(board) {
    const fen = board.toFEN(false, false) + " -";
    const moves = this.openingBook[fen];

    if (moves) {
      // Pick a random move from the book
      const pickedMove = moves[Math.floor(Math.random() * moves.length)];
      return Move.UCIToMove(pickedMove, board);
    }
    return null;
  }

  //Receives list of legal moves and returns the best one
  async getBestMove(legalMoves, timeLimitMs = 1500, onDepthCompleted = null, nodeLimit = Infinity, yieldEveryNodes = DEFAULT_YIELD_EVERY_NODES) {
    //Attempting to get a book move without searching
    const bookMove = this.getBookMove(this.board);

    this.bestMoveFound = legalMoves[0]; //If for some reason no move is found play the first
    this.principalVariation = [legalMoves[0]];
    this.searchCancelled = false;
    this.nodesSearched = 0; //Nodes searches on this request
    this.maxNodes = Number.isFinite(nodeLimit) ? Math.max(0, Math.floor(nodeLimit)) : Infinity;
    this.yieldEveryNodes = Number.isFinite(yieldEveryNodes) ? Math.max(1, Math.floor(yieldEveryNodes)) : DEFAULT_YIELD_EVERY_NODES;
    // A numeric limit retains the old API.  Clock searches may instead provide
    // a soft/hard pair: the hard limit is never crossed, while the soft limit
    // is used only between completed iterations so a usable PV is retained.
    const timeLimits = typeof timeLimitMs === "object" && timeLimitMs !== null ? timeLimitMs : null;
    const hardLimitMs = timeLimits ? timeLimits.hardLimitMs : timeLimitMs;
    const softLimitMs = timeLimits ? timeLimits.softLimitMs : hardLimitMs;
    const searchStart = performance.now();
    this.searchDeadline = Number.isFinite(hardLimitMs) ? searchStart + Math.max(1, hardLimitMs) : Infinity;
    this.searchSoftDeadline = Number.isFinite(softLimitMs) ? searchStart + Math.max(1, Math.min(softLimitMs, hardLimitMs)) : Infinity;
    this.timeManagement =
      timeLimits && timeLimits.dynamic !== false && Number.isFinite(softLimitMs) && Number.isFinite(hardLimitMs)
        ? {
            searchStart,
            softLimitMs,
            hardLimitMs,
            legalMovesCount: Array.isArray(legalMoves) ? legalMoves.length : 0,
            rootComplexity: Number.isFinite(timeLimits.rootComplexity) ? timeLimits.rootComplexity : this.estimateRootComplexity(legalMoves),
            complexity: Number.isFinite(timeLimits.rootComplexity) ? timeLimits.rootComplexity : this.estimateRootComplexity(legalMoves),
            previousScore: null,
            previousPVMove: null,
            previousIterationMs: 0,
            stableMoveDepths: 0,
          }
        : null;
    this.maxDepthReached = 0;
    // Seed the count table from positions played before the search. Search
    // nodes increment/decrement their position in constant time.
    this.repetitionCounts.clear();
    for (const zobrist of this.board.repetitionHistory) this.pushRepetition(zobrist);

    // Age TT entries once per root search. Entries are retained across moves;
    // the fixed-size replacement table evicts stale, shallow collisions.
    this.ttGeneration++;
    this.killerMoves = Array.from({ length: 64 }, () => [null, null]);
    for (let p = 0; p < 7; p++) {
      for (let s = 0; s < 64; s++) {
        this.historyHeuristic[p][s] = Math.floor(this.historyHeuristic[p][s] / 8);
      }
    }

    this.isBookMove = Boolean(bookMove); //Used for evaluation reporting to the UI
    const maxDepth = 20;

    //Iterative deepening. Performing a search from a depth of 1 all the way up to a depth of maxDepth
    //This is done to keep track of the best moves at every depth and look at those first on the next depth to prune more branches
    for (let depth = 1; depth <= maxDepth; depth++) {
      this.currentSearchDepth = depth;
      const iterationStart = performance.now();

      //Aspiration windows. First depths are evaluated fully to get a proper evaluation. Later depths are searched with a window of 50 centipawns around the previous depth's evaluation
      //Because the window is small, the search will be faster. If the evaluation is outside of the window, the search is repeated with a larger window until it is within the window
      try {
        let window = depth <= 4 ? Infinity : 50;
        let lo = this.evaluation - window,
          hi = this.evaluation + window;
        let score, pv;
        while (true) {
          const res = await this.negaMax(lo, hi, depth, 0, 0);
          score = res.score;
          pv = res.pv;
          if (score <= lo) {
            lo -= window;
            window *= 2;
          } else if (score >= hi) {
            hi += window;
            window *= 2;
          } else {
            /* accept */ break;
          }
        }

        //Depth was completed without cancelling, store best moves and evaluation
        this.evaluation = score;
        this.maxDepthReached = this.currentSearchDepth;
        if (pv && pv.length != 0) {
          this.bestMoveFound = pv[0];
          this.principalVariation = pv;
        }

        if (typeof onDepthCompleted === "function") {
          onDepthCompleted({
            depth,
            score: this.evaluation,
            pv: this.principalVariation,
            bestMove: this.bestMoveFound,
            nodesSearched: this.nodesSearched,
          });
        }

        // Never stop part-way through an iteration merely because the soft
        // limit has elapsed.  A volatile or tactically dense position may use
        // extra time, but only if the next iteration is predicted to finish
        // before the clock-safe hard deadline.
        if (this.shouldStopAfterCompletedDepth(score, pv, performance.now() - iterationStart)) break;

        // Also yield between completed depths, including very small searches.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } catch (error) {
        if (error instanceof SearchTimeout) {
          this.searchCancelled = true;
          break;
        }
        throw error;
      }
    }

    //If there is a book move play that instead. Do it after a search to make the bot more human in the opening instead of playing immediately
    /*if (bookMove) {
      this.bestMoveFound = bookMove;
      this.principalVariation = [bookMove];
      this.isBookMove = true;
      return;
    }*/
  }

  cancelSearch() {
    this.searchCancelled = true;
  }

  // Pondering starts with no deadline.  When the GUI confirms the predicted
  // move with "ponderhit", begin using the normal clock allocation from that
  // moment rather than from the start of the ponder search.
  setSearchTimeLimit(timeLimitMs) {
    const limits = typeof timeLimitMs === "object" && timeLimitMs !== null ? timeLimitMs : null;
    const hardLimitMs = limits ? limits.hardLimitMs : timeLimitMs;
    const softLimitMs = limits ? limits.softLimitMs : hardLimitMs;
    const now = performance.now();
    this.searchDeadline = Number.isFinite(hardLimitMs) ? now + Math.max(1, hardLimitMs) : Infinity;
    this.searchSoftDeadline = Number.isFinite(softLimitMs) ? now + Math.max(1, Math.min(softLimitMs, hardLimitMs)) : Infinity;
    if (limits && limits.dynamic !== false) {
      this.timeManagement = {
        searchStart: now,
        softLimitMs,
        hardLimitMs,
        legalMovesCount: this.timeManagement?.legalMovesCount || 30,
        rootComplexity: Number.isFinite(limits.rootComplexity) ? limits.rootComplexity : 50,
        complexity: Number.isFinite(limits.rootComplexity) ? limits.rootComplexity : 50,
        previousScore: null,
        previousPVMove: null,
        previousIterationMs: 0,
        stableMoveDepths: 0,
      };
    }
  }

  // Cheap root information available before search.  Its main purpose is to
  // avoid spending a normal budget on forced positions and to reserve more
  // time for branches with many tactical alternatives.
  estimateRootComplexity(legalMoves) {
    if (!legalMoves || legalMoves.length === 0) return 0;
    let tacticalMoves = 0;
    for (const move of legalMoves) {
      if (Move.isCapture(move, this.board) || Move.isPromotion(move)) tacticalMoves++;
    }
    const movePressure = Math.min(30, legalMoves.length) * 1.15;
    const tacticalPressure = (tacticalMoves / legalMoves.length) * 30;
    const checkPressure = this.board.inCheck() ? 18 : 0;
    return Math.max(5, Math.min(95, 12 + movePressure + tacticalPressure + checkPressure));
  }

  shouldStopAfterCompletedDepth(score, pv, iterationMs) {
    const manager = this.timeManagement;
    if (!manager) return false;

    // 1. If only 1 legal move exists, stop immediately after depth 1
    if (manager.legalMovesCount <= 1) return true;

    // 2. If checkmate is found, no deeper search will find a better move
    if (this.isMateScore(score) && score > 0) return true;

    const currentPVMove = pv && pv.length ? pv[0] : null;

    // 3. Track stability of best move and score
    let complexity = manager.rootComplexity;
    if (manager.previousScore !== null) {
      const scoreDiff = Math.abs(score - manager.previousScore);
      complexity += Math.min(28, scoreDiff / 5);
      if (currentPVMove !== null && currentPVMove !== manager.previousPVMove) {
        complexity += 18;
        manager.stableMoveDepths = 0;
      } else {
        manager.stableMoveDepths = (manager.stableMoveDepths || 0) + 1;
      }
    }
    manager.complexity = Math.max(0, Math.min(100, complexity));
    manager.previousScore = score;
    manager.previousPVMove = currentPVMove;
    manager.previousIterationMs = iterationMs;

    const now = performance.now();

    // 4. CRITICAL: Can we afford another iteration before the HARD deadline?
    // In chess search trees, branching factor per depth is typically ~2.5x - 4x.
    // We estimate the next depth will take iterationMs * 2.5 (at least 5ms).
    // If starting another depth is predicted to overrun the hard deadline, stop immediately!
    const predictedNextIterationMs = Math.max(5, iterationMs * 2.5);
    if (now + predictedNextIterationMs >= this.searchDeadline) {
      return true;
    }

    // 5. Early exit for obvious / highly stable moves:
    // If depth >= 4, the best move has stayed identical for multiple depths with low score shift,
    // and root complexity is low or moderate, we don't need to burn the entire soft budget.
    const searchElapsed = now - (manager.searchStart || this.searchSoftDeadline - (manager.softLimitMs || 1000));
    const softLimit = manager.softLimitMs || this.searchSoftDeadline - (manager.searchStart || now);
    if (this.currentSearchDepth >= 4 && manager.stableMoveDepths >= 2 && manager.complexity < 45 && searchElapsed >= softLimit * 0.45) {
      return true;
    }

    // 6. If we have not yet reached the soft deadline, continue searching
    if (now < this.searchSoftDeadline) return false;

    // 7. If soft deadline has passed:
    // Only continue into an overtime iteration if the position is complex/unstable
    // AND we can comfortably afford it within the hard deadline.
    const canAffordOvertime = now + predictedNextIterationMs < this.searchDeadline - 15;
    return manager.complexity < 55 || !canAffordOvertime;
  }

  async checkSearchState() {
    if (
      this.searchCancelled ||
      this.nodesSearched >= this.maxNodes ||
      (Number.isFinite(this.searchDeadline) && performance.now() >= this.searchDeadline)
    ) {
      this.searchCancelled = true;
      throw new SearchTimeout("Search cancelled");
    }

    this.nodesSearched++;

    if (this.nodesSearched % this.yieldEveryNodes === 0) {
      // A macrotask yield lets the worker handle queued postMessage events.
      // Re-check state afterward because one may have cancelled this search.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.searchCancelled || (Number.isFinite(this.searchDeadline) && performance.now() >= this.searchDeadline)) {
        this.searchCancelled = true;
        throw new SearchTimeout("Search cancelled");
      }
    }
  }

  isRepetition() {
    // Current position is included in the table, so two occurrences preserve
    // the engine's existing repetition semantics without a line scan.
    return (this.repetitionCounts.get(this.board.zobristKey) || 0) >= 2;
  }

  pushRepetition(zobrist) {
    this.repetitionCounts.set(zobrist, (this.repetitionCounts.get(zobrist) || 0) + 1);
  }

  popRepetition(zobrist) {
    const count = this.repetitionCounts.get(zobrist);
    if (count <= 1) this.repetitionCounts.delete(zobrist);
    else this.repetitionCounts.set(zobrist, count - 1);
  }

  getTranspositionKey() {
    // Zobrist deliberately represents the board position only.  The halfmove
    // clock changes the value near a fifty-move draw, so distinguish it here.
    return `${this.board.zobristKey}:${this.board.plyCounter}`;
  }

  getTTIndex() {
    return Number(this.board.zobristKey & this.ttMask);
  }

  probeTransposition(key) {
    const entry = this.transpositionTable[this.getTTIndex()];
    if (!entry || entry.key !== key) return null;
    entry.generation = this.ttGeneration;
    return entry;
  }

  storeTransposition(key, entry) {
    const index = this.getTTIndex();
    const previous = this.transpositionTable[index];
    entry.key = key;
    entry.generation = this.ttGeneration;

    if (!previous || previous.key === key) {
      // Do not discard a deeper bound for a shallower revisit of the same node.
      if (!previous || entry.depth > previous.depth || (entry.depth === previous.depth && entry.flag === "EXACT" && previous.flag !== "EXACT")) {
        this.transpositionTable[index] = entry;
      } else {
        previous.generation = this.ttGeneration;
      }
      return;
    }

    // A slot collision replaces shallow entries immediately. Deeper entries
    // survive until they have aged across several independent root searches.
    const incomingPriority = entry.depth * 4 + this.ttGeneration;
    const previousPriority = previous.depth * 4 + previous.generation;
    if (incomingPriority >= previousPriority) this.transpositionTable[index] = entry;
  }

  //Main search function. Returns the evaluation of the position being searched
  //as well as the principal variation (best moves for either side on a given position)
  async negaMax(alph, beta, depth, ply, currExtensions, useNullMove = true) {
    await this.checkSearchState();

    // These conditions also apply at the root. The count table includes the
    // current position, so two occurrences constitute a draw.
    if (this.board.plyCounter >= 100 || this.isRepetition()) return { score: 0, pv: [] };

    if (ply > 0) {
      //If forced mate has been found already stop searching
      alph = Math.max(alph, -this.mateScore + ply);
      beta = Math.min(beta, this.mateScore - ply);
      if (alph >= beta) return { score: alph, pv: [] };
    }

    const transpositionKey = this.getTranspositionKey();
    const entry = this.probeTransposition(transpositionKey);
    //If we have seen this position from a different move order before fetch the refutation score and its principal variation
    if (entry && entry.depth >= depth) {
      const ttScore = this.adjustMateScoreForRetrieval(entry.bestScore, ply);
      if (entry.flag === "EXACT") return { score: ttScore, pv: entry.pv || [] };
      if (entry.flag === "ALPHA" && ttScore <= alph) return { score: alph, pv: entry.pv || [] };
      if (entry.flag === "BETA" && ttScore >= beta) return { score: beta, pv: entry.pv || [] };
    }

    //Base case when depth = 0, return the evaluation gotten from quiescence search and an empty principal variation
    if (depth == 0) {
      const qScore = await this.quiescence(alph, beta, ply);
      return { score: qScore, pv: [] };
    }

    //Null move pruning
    //Do not do null move at root (ply == 0), when in check, or if depth is too low
    if (useNullMove && ply > 0 && depth >= 3 && !this.board.inCheck()) {
      const R = 3 + Math.floor(depth / 6);
      //Zugzwang protection: only perform null move if side to move has major/minor pieces
      const allyPieces = this.board.getAllies(this.board.clrToMove);
      const hasNonPawns = (allyPieces.knights | allyPieces.bishops | allyPieces.rooks | allyPieces.queens) !== 0n;

      if (hasNonPawns) {
        this.board.makeNullMove(true);
        let child;
        try {
          child = await this.negaMax(-beta, -beta + 1, depth - 1 - R, ply + 1, 0, false);
        } finally {
          this.board.unmakeNullMove(true);
        }
        const nullScore = -child.score;

        if (nullScore >= beta) {
          return { score: beta, pv: [] }; //Fail-hard beta cutoff
        }
      }
    }

    let moves = this.moveGen.generateMoves(this.board);
    if (moves.length == 0) {
      //Return checkmate score
      if (this.moveGen.inCheck) return { score: -this.mateScore + ply, pv: [] };
      //Return draw score if stalemate
      return { score: 0, pv: [] };
    }

    const firstAlpha = alph;
    const firstBeta = beta;
    const nodeInCheck = this.moveGen.inCheck;

    moves = this.sortMoves(moves, this.board, this.moveGen.enemyPawnAttacksMask, depth, ply);

    let bestScore = -Infinity;
    let bestMoveLocal = moves[0];
    let bestPV = [];

    for (let moveIndex = 0; moveIndex < moves.length; moveIndex++) {
      const move = moves[moveIndex];
      const isQuiet = !Move.isCapture(move, this.board) && !Move.isPromotion(move);
      this.board.makeMove(move, true);
      this.pushRepetition(this.board.zobristKey);

      //Extending searches for checks and pawns about to promote
      let extensions = 0;
      if (currExtensions < this.maxExtensions) {
        if (this.board.inCheck()) extensions = 1;
        const movedPiece = this.board.piecesList[Move.targetSqr(move)];
        const targetRank = BoardUtil.squareToRank(Move.targetSqr(move));
        if (Piece.type(movedPiece) == pawn && (targetRank == 1 || targetRank == 6)) extensions = 1;
      }

      const fullDepth = depth - 1 + extensions;
      // Reduce only late, quiet moves in stable nodes. Checks, promotions,
      // killer moves, and moves that give check are always searched fully.
      const canReduce = depth >= 3 && moveIndex >= 3 && isQuiet && !nodeInCheck && extensions == 0 && !this.killerMoves[ply].includes(move);
      const reduction = canReduce ? (depth >= 6 && moveIndex >= 6 ? 2 : 1) : 0;
      const reducedDepth = Math.max(0, fullDepth - reduction);

      let child;
      let score;
      try {
        // Principal Variation Search: the first move gets the full window;
        // later moves first try a cheap null-window search.
        if (moveIndex == 0) {
          child = await this.negaMax(-beta, -alph, reducedDepth, ply + 1, currExtensions + extensions);
        } else {
          child = await this.negaMax(-alph - 1, -alph, reducedDepth, ply + 1, currExtensions + extensions);
        }
        score = -child.score;

        // A reduced move that looks promising, or a PVS probe that improves
        // alpha, must be confirmed at the unreduced full window.
        const needsFullResearch = (reduction > 0 && score > alph) || (reduction == 0 && moveIndex > 0 && score > alph && score < beta);
        if (needsFullResearch) {
          child = await this.negaMax(-beta, -alph, fullDepth, ply + 1, currExtensions + extensions);
          score = -child.score;
        }
      } finally {
        this.popRepetition(this.board.zobristKey);
        this.board.unmakeMove(move, true);
      }

      if (score > bestScore) {
        bestScore = score;
        bestMoveLocal = move;
        //Appending the current best move to the principal variation
        bestPV = [move, ...child.pv];

        if (score > alph) alph = score;
      }

      if (score >= beta) {
        // Update killers & history on cutoff for quiet moves
        if (!Move.isCapture(move, this.board)) {
          if (this.killerMoves[ply][0] !== move) {
            this.killerMoves[ply][1] = this.killerMoves[ply][0];
            this.killerMoves[ply][0] = move;
          }
          const attackerPiece = this.board.piecesList[Move.startSqr(move)];
          const pieceType = Piece.type(attackerPiece);
          const targetSquare = Move.targetSqr(move);
          this.historyHeuristic[pieceType][targetSquare] += depth * depth;
        }

        const storedScore = this.adjustMateScoreForStorage(bestScore, ply);
        this.storeTransposition(transpositionKey, {
          depth,
          bestScore: storedScore,
          flag: "BETA",
          bestMoveLocal,
          pv: bestPV,
        });
        return { score: bestScore, pv: bestPV };
      }
    }

    //Storing refutation score on transposition table along its principal variation
    const flag = bestScore <= firstAlpha ? "ALPHA" : "EXACT";

    const storedScore = this.adjustMateScoreForStorage(bestScore, ply);
    this.storeTransposition(transpositionKey, {
      depth,
      bestScore: storedScore,
      flag,
      bestMoveLocal,
      pv: bestPV,
    });

    return { score: bestScore, pv: bestPV };
  }

  isMateScore(score) {
    return Math.abs(score) > this.mateScore - 1000; //Near mate
  }

  adjustMateScoreForStorage(score, ply) {
    if (this.isMateScore(score)) {
      if (score > 0)
        return score + ply; //Sooner mate for us is bigger
      else return score - ply; //Sooner mate for opponent is smaller
    }
    return score;
  }

  adjustMateScoreForRetrieval(score, ply) {
    if (this.isMateScore(score)) {
      if (score > 0)
        return score - ply; //Undo storage adjustment
      else return score + ply;
    }
    return score;
  }

  //Does a search of all captures to abritrary depth until there are none left
  async quiescence(alph, beta, ply = 0) {
    await this.checkSearchState();

    if (this.board.plyCounter >= 100 || this.isRepetition()) return 0;

    // Stand-pat is illegal while in check. Search every legal evasion; if
    // there is none this is checkmate, even though it occurs at the horizon.
    if (this.board.inCheck()) {
      let evasions = this.moveGen.generateMoves(this.board);
      if (evasions.length === 0) return -this.mateScore + ply;

      evasions = this.sortMoves(evasions, this.board, this.moveGen.enemyPawnAttacksMask, 0, ply);
      let bestValue = -Infinity;
      for (const move of evasions) {
        this.board.makeMove(move, true);
        this.pushRepetition(this.board.zobristKey);
        let score;
        try {
          score = -(await this.quiescence(-beta, -alph, ply + 1));
        } finally {
          this.popRepetition(this.board.zobristKey);
          this.board.unmakeMove(move, true);
        }

        if (score >= beta) return score;
        if (score > bestValue) bestValue = score;
        if (score > alph) alph = score;
      }
      return bestValue;
    }

    //Stand-pat evaluation
    const evaluation = this.evaluate(this.board);
    let bestValue = evaluation;
    if (bestValue >= beta) return bestValue;
    if (bestValue > alph) alph = bestValue;

    const deltaMargin = 50;
    let captureMoves = this.moveGen.generateMoves(this.board, true);
    captureMoves = this.sortQuiescenceMoves(captureMoves, this.board);

    for (let capture of captureMoves) {
      const capturedType = Move.capturePieceType(capture, this.board);
      const capturedValue = this.pieceValues[capturedType];

      //Delta pruning
      if (!Move.isPromotion(capture)) {
        //Not allowing pruning of promotion captures
        if (bestValue + capturedValue + deltaMargin < alph) continue;
      }

      this.board.makeMove(capture, true);
      this.pushRepetition(this.board.zobristKey);
      let score;
      try {
        score = -(await this.quiescence(-beta, -alph, ply + 1));
      } finally {
        this.popRepetition(this.board.zobristKey);
        this.board.unmakeMove(capture, true);
      }

      if (score >= beta) return score;
      if (score > bestValue) bestValue = score;
      if (score > alph) alph = score;
    }
    return bestValue;
  }

  //Generates the "value" of a capture move
  //Capturing a queen with a pawn is usually preferable over capturing a pawn with a queen
  getMVVLVA(move, board) {
    const attackerPiece = board.piecesList[Move.startSqr(move)];
    const victimType = Move.capturePieceType(move, board);
    const attackerType = Piece.type(attackerPiece);

    if (victimType == none) return 0;
    return this.seePieceValues[victimType] * 10 - this.seePieceValues[attackerType];
  }

  // Finds the least-valuable piece of `side` present in the `attackers` bitboard.
  // Returns { sqr, type } or null if no attacker of that color exists.
  getLVA(attackers, allyBitboards) {
    const order = [
      [allyBitboards.pawns, pawn],
      [allyBitboards.knights, knight],
      [allyBitboards.bishops, bishop],
      [allyBitboards.rooks, rook],
      [allyBitboards.queens, queen],
      [allyBitboards.king, king],
    ];
    for (const [bb, type] of order) {
      const hit = attackers & bb;
      if (hit !== 0n) {
        return { sqr: BBUtil.getLSBIndex(hit), type };
      }
    }
    return null;
  }

  // Recursive SEE helper: returns the best gain the current `side` can achieve
  // by recapturing on `targetSqr` (where `pieceType` currently sits).
  // `occupancy` and `attackers` already reflect all previous removes.
  // Returns 0 if no attacker exists or recapturing would be losing.
  seeRecapture(targetSqr, pieceType, occupancy, attackers, side, board) {
    const allyBitboards = side === white ? board.white : board.black;
    const lva = this.getLVA(attackers, allyBitboards);
    if (lva === null) return 0; // No piece available to recapture

    // If the least valuable attacker is the king, it can only capture if the square is not defended
    // (a king cannot legally capture into check)
    if (lva.type === king) {
      const opponentSide = side === white ? black : white;
      const opponentBitboards = opponentSide === white ? board.white : board.black;
      if ((attackers & opponentBitboards.pieces & occupancy) !== 0n) {
        return 0;
      }
    }

    // A pawn that captures onto its promotion rank promotes to a queen
    let effectiveLvaType = lva.type;
    let promoBonus = 0;
    if (lva.type === pawn) {
      const rank = BoardUtil.squareToRank(targetSqr);
      // White promotes at rank 0 (squares 0-7), black at rank 7 (squares 56-63)
      if ((side === white && rank === 0) || (side === black && rank === 7)) {
        effectiveLvaType = queen;
        promoBonus = this.seePieceValues[queen] - this.seePieceValues[pawn];
      }
    }

    // Remove the LVA from occupancy — it moves to targetSqr
    const newOcc = occupancy & ~(1n << BigInt(lva.sqr));
    // Recompute attacker map: any X-ray slider behind the LVA is now revealed
    const newAttackers = this.board.getAttackersTo(targetSqr, newOcc);

    const gainIfCapture = this.seePieceValues[pieceType] + promoBonus;
    const opponentGain = this.seeRecapture(targetSqr, effectiveLvaType, newOcc, newAttackers, side === white ? black : white, board);

    // Only recapture if the net result is positive (don't recapture into a losing trade)
    return Math.max(0, gainIfCapture - opponentGain);
  }

  // Static Exchange Evaluation.
  // Estimates the net material gain for `board.clrToMove` from the initial capture of
  // `capturedType` on `targetSqr` with the `attackerType` piece from `attackerSqr`.
  // Positive = winning/equal trade; negative = losing trade.
  see(targetSqr, capturedType, attackerSqr, attackerType, board) {
    // A pawn that captures onto its promotion rank is treated as a queen
    let effectiveAttackerType = attackerType;
    let promoBonus = 0;
    if (attackerType === pawn) {
      const rank = BoardUtil.squareToRank(targetSqr);
      if ((board.clrToMove === white && rank === 0) || (board.clrToMove === black && rank === 7)) {
        effectiveAttackerType = queen;
        promoBonus = this.seePieceValues[queen] - this.seePieceValues[pawn];
      }
    }

    // Remove the initial attacker from occupancy (it moves to targetSqr)
    const newOcc = BBUtil.unsetBit(attackerSqr, board.piecesBB);
    // Build the full attacker map from the resulting position
    const attackers = this.board.getAttackersTo(targetSqr, newOcc);

    // Let the opponent recapture optimally; their best gain determines our net score
    const opponentSide = board.clrToMove === white ? black : white;
    const opponentBitboards = opponentSide === white ? board.white : board.black;

    // A king cannot legally capture onto a defended square (cannot move into check)
    if (attackerType === king) {
      if ((attackers & opponentBitboards.pieces & newOcc) !== 0n) {
        return -this.seePieceValues[king];
      }
    }

    const opponentGain = this.seeRecapture(targetSqr, effectiveAttackerType, newOcc, attackers, opponentSide, board);

    return this.seePieceValues[capturedType] + promoBonus - opponentGain;
  }

  //Sorts the capture moves in descending order to look at the best captures first during quiescence.
  //Captures with a negative SEE (losing trades) are pruned entirely from quiescence.
  sortQuiescenceMoves(moves, board) {
    const len = moves.length;
    if (len <= 1) return moves;

    const filteredMoves = [];
    const scores = [];

    for (let i = 0; i < len; i++) {
      const m = moves[i];
      let score;

      if (Move.isPromotion(m)) {
        // Always include promotions; MVV-LVA orders them relative to each other
        score = this.getMVVLVA(m, board) + 20000;
      } else if (Move.flag(m) !== enPassantFlag) {
        // Score with SEE and prune captures that lose material
        const targetSqr = Move.targetSqr(m);
        const attackerSqr = Move.startSqr(m);
        const capturedType = Move.capturePieceType(m, board);
        const attackerType = Piece.type(board.piecesList[attackerSqr]);
        const seeScore = this.see(targetSqr, capturedType, attackerSqr, attackerType, board);
        if (seeScore < 0) continue; // Skip losing captures in quiescence
        score = seeScore * 1000 + this.getMVVLVA(m, board);
      } else {
        // En passant: always a pawn-for-pawn trade, keep with MVV-LVA score
        score = this.getMVVLVA(m, board);
      }

      filteredMoves.push(m);
      scores.push(score);
    }

    // In-place sort parallel arrays without object allocation
    const count = filteredMoves.length;
    for (let i = 1; i < count; i++) {
      const moveKey = filteredMoves[i];
      const scoreKey = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < scoreKey) {
        filteredMoves[j + 1] = filteredMoves[j];
        scores[j + 1] = scores[j];
        j--;
      }
      filteredMoves[j + 1] = moveKey;
      scores[j + 1] = scoreKey;
    }

    return filteredMoves;
  }

  //Sorts the moves in descending order to look at the best moves first during normal search.
  //Captures are scored with SEE: winning captures go above killers, losing captures go below quiet moves.
  sortMoves(moves, board, enemyPawnAttackMask, depth, ply = 0) {
    const len = moves.length;
    if (len <= 1) return moves;

    const ttEntry = this.probeTransposition(this.getTranspositionKey());
    const ttMove = ttEntry ? ttEntry.bestMoveLocal || ttEntry.bestMove : null;

    // The PV move expected at this ply (from the previous completed iteration)
    const pvMoveAtThisPly = this.principalVariation && this.principalVariation.length > ply ? this.principalVariation[ply] : null;

    const scores = new Int32Array(len);
    const killer0 = this.killerMoves[ply][0];
    const killer1 = this.killerMoves[ply][1];

    for (let i = 0; i < len; i++) {
      const m = moves[i];
      let score = 0;

      //Looking at the principal variation (pv) from shallower searches first for iterative deepening
      if (pvMoveAtThisPly && m === pvMoveAtThisPly && depth === this.currentSearchDepth) {
        score += 900000;
      }

      //Look at the best move of transpositions second
      if (ttMove && m === ttMove) {
        score += 500000;
      }

      //Prioritize looking at promotions
      if (Move.isPromotion(m)) {
        score += 20000;
      }

      if (Move.isCapture(m, board)) {
        if (Move.flag(m) !== enPassantFlag) {
          // Use SEE to separate winning captures (above killers) from losing ones (below quiet moves)
          const targetSqr = Move.targetSqr(m);
          const attackerSqr = Move.startSqr(m);
          const capturedType = Move.capturePieceType(m, board);
          const attackerType = Piece.type(board.piecesList[attackerSqr]);
          const seeScore = this.see(targetSqr, capturedType, attackerSqr, attackerType, board);

          if (seeScore >= 0) {
            // Winning/equal capture: score above killers (10000) and quiet history
            score += 50000 + seeScore * 100 + this.getMVVLVA(m, board);
          } else {
            // Losing capture: large negative penalty, tried after quiet moves
            score += -50000 + seeScore;
          }
        } else {
          // En passant: pawn-for-pawn trade, treat as neutral capture
          score += this.getMVVLVA(m, board) + 2000;
        }
      } else {
        // Quiet moves: killers, history, pawn-attack penalty
        if (m === killer0 || m === killer1) {
          score += 10000;
        }

        const attacker = board.piecesList[Move.startSqr(m)];
        score += this.historyHeuristic[Piece.type(attacker)][Move.targetSqr(m)];

        //Penalize quiet moves targeting squares controlled by opponent pawns
        if (BBUtil.isBitSet(Move.targetSqr(m), enemyPawnAttackMask)) {
          score -= 50;
        }
      }

      scores[i] = score;
    }

    // In-place sort moves using insertion sort (efficient for small move lists)
    for (let i = 1; i < len; i++) {
      const moveKey = moves[i];
      const scoreKey = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < scoreKey) {
        moves[j + 1] = moves[j];
        scores[j + 1] = scores[j];
        j--;
      }
      moves[j + 1] = moveKey;
      scores[j + 1] = scoreKey;
    }

    return moves;
  }

  //Calculates which game phase we are currently on (24 if all pieces remain, 0 if just kings)
  //to smoothly interpolate between piece square table values
  calcGamePhase(board) {
    let phase = 0;
    phase += this.phaseValues[pawn] * (board.pieceCounts[white][pawn] + board.pieceCounts[black][pawn]);
    phase += this.phaseValues[knight] * (board.pieceCounts[white][knight] + board.pieceCounts[black][knight]);
    phase += this.phaseValues[bishop] * (board.pieceCounts[white][bishop] + board.pieceCounts[black][bishop]);
    phase += this.phaseValues[rook] * (board.pieceCounts[white][rook] + board.pieceCounts[black][rook]);
    phase += this.phaseValues[queen] * (board.pieceCounts[white][queen] + board.pieceCounts[black][queen]);
    //Clamping phase in case of weird positions
    if (phase < 0) phase = 0;
    if (phase > this.totalPhase) phase = this.totalPhase;
    return phase;
  }

  //Passing board as a parameter to allow for evaluation on a position the bot isn't playing in for testing
  evaluate(board) {
    if (this.isInsufficientMaterial(board)) return 0;

    const perspectiveMult = board.clrToMove == white ? 1 : -1;
    const phase = this.calcGamePhase(board); //Getting the current phase of the game (mid/end game)
    let allPiecesBB = board.piecesBB;

    let evaluation = 0;
    let whiteMaterial = 0;
    let blackMaterial = 0;

    let hasBishop = {
      light: [false, false],
      dark: [false, false],
    };

    while (allPiecesBB != 0n) {
      const sqr = BBUtil.getLSBIndex(allPiecesBB);
      const piece = board.piecesList[sqr];
      const pieceType = Piece.type(piece);
      const pieceClr = Piece.clr(piece);
      const sign = pieceClr == white ? 1 : -1;
      const index = pieceClr == white ? sqr : BoardUtil.mirrorIndex(sqr);
      let pieceValue = 0;

      //Adding up material count for both colors using piece square tables
      switch (pieceType) {
        case pawn:
          const midPValue = this.pawnEarlyPST[index]; //middlegame PST
          const endPValue = this.pawnEndPST[index]; //endgame PST
          pieceValue = this.pieceValues[pawn];
          pieceValue += (midPValue * phase + endPValue * (this.totalPhase - phase)) / this.totalPhase;
          break;
        case knight:
          pieceValue = this.pieceValues[knight] + this.knightPST[index];
          //Adding some value to outposts
          if (this.isOutpost(sqr, pieceClr, board)) pieceValue += this.params.outpostBonus;
          break;
        case bishop:
          pieceValue = this.pieceValues[bishop] + this.bishopPST[index];
          const bishopType = BoardUtil.isLightSquare(sqr) ? hasBishop.light : hasBishop.dark;
          bishopType[pieceClr] = true;
          break;
        case rook:
          pieceValue = this.pieceValues[rook] + this.rookPST[index];

          //Rewarding rooks being on open files
          const allPawnsBB = board.white.pawns | board.black.pawns;
          const rookFile = BoardUtil.squareToFile(sqr);
          const rookFileMask = BBUtil.fileMasks[rookFile];
          if ((rookFileMask & allPawnsBB) == 0n) pieceValue += this.params.rookOpenFileBonus;

          //Rewarding rooks being connected
          const allyRooks = pieceClr == white ? board.white.rooks : board.black.rooks;
          const blockersMask = board.piecesBB;

          //If the current rook sees an ally rook (they are connected)
          if ((BBUtil.rookMoves(sqr, blockersMask) & allyRooks) != 0n) pieceValue += this.params.connectedRooksBonus * 0.5; //Divide by 2 to avoid giving bonus twice
          break;
        case queen:
          pieceValue = this.pieceValues[queen] + this.queenPST[index];
          break;
        case king:
          const midKValue = this.kingEarlyPST[index]; //middlegame PST
          const endKValue = this.kingEndPST[index]; //endgame PST
          pieceValue = (midKValue * phase + endKValue * (this.totalPhase - phase)) / this.totalPhase;
          break;
      }

      if (pieceClr == white) {
        whiteMaterial += this.pieceValues[pieceType];
      } else {
        blackMaterial += this.pieceValues[pieceType];
      }

      evaluation += pieceValue * sign;
      allPiecesBB &= allPiecesBB - 1n;
    }

    //Giving extra bonus for having pair of bishops of different color
    if (hasBishop.light[white] && hasBishop.dark[white]) evaluation += this.params.bishopPairBonus;
    if (hasBishop.light[black] && hasBishop.dark[black]) evaluation -= this.params.bishopPairBonus;

    const wKingSquare = BBUtil.getLSBIndex(board.white.king);
    const bKingSquare = BBUtil.getLSBIndex(board.black.king);

    // Mating guidance is meaningful only when the defender has a bare king and
    // the attacker has enough material.  It must not distort drawn or pawn-only
    // endgames.
    evaluation += this.calcMopUpScore(wKingSquare, bKingSquare, whiteMaterial, blackMaterial);
    evaluation -= this.calcMopUpScore(bKingSquare, wKingSquare, blackMaterial, whiteMaterial);

    if (phase > 0) {
      evaluation += this.evaluateKingSafety(board);
      evaluation += this.evaluateMobility(board);

      //Small bonus for being the player to move (counterproductive in endgames)
      evaluation += this.params.myTurnBonus * perspectiveMult;
    }

    //Evaluating quality of pawns for each side
    evaluation += this.evaluatePawns(board, phase);

    return evaluation * perspectiveMult;
  }

  isInsufficientMaterial(board) {
    if (board.white.pawns || board.black.pawns || board.white.rooks || board.black.rooks || board.white.queens || board.black.queens) return false;

    const whiteMinors = BBUtil.countBits(board.white.knights | board.white.bishops);
    const blackMinors = BBUtil.countBits(board.black.knights | board.black.bishops);
    const totalMinors = whiteMinors + blackMinors;
    if (totalMinors <= 1) return true;

    // K+NN versus K cannot force mate, nor can a position containing only
    // bishops confined to one square colour.
    if (board.white.bishops === 0n && board.black.bishops === 0n) return totalMinors <= 2;
    if (whiteMinors <= 1 && blackMinors <= 1) return true;

    let bishops = board.white.bishops | board.black.bishops;
    let hasLight = false;
    let hasDark = false;
    while (bishops) {
      const sqr = BBUtil.getLSBIndex(bishops);
      if (BoardUtil.isLightSquare(sqr)) hasLight = true;
      else hasDark = true;
      bishops &= bishops - 1n;
    }
    return !hasLight || !hasDark;
  }

  calcMopUpScore(allyKingSqr, enemyKingSqr, allyMaterial, enemyMaterial) {
    // Only guide technically won, bare-king endings.  Applying this to equal
    // material or a pawn ending creates artificial multi-pawn evaluations.
    if (enemyMaterial !== 0 || allyMaterial < this.pieceValues[rook]) return 0;

    let mopUpScore = 0;
    mopUpScore += (14 - BoardUtil.manhattanDistances[allyKingSqr][enemyKingSqr]) * 12;
    mopUpScore += BoardUtil.distanceToCenter[enemyKingSqr] * 35;

    return mopUpScore;
  }

  evaluateMobility(board) {
    // Pseudo-legal mobility is deliberately used here: it is much cheaper than
    // generating all legal moves twice and never mutates board.clrToMove.
    return (this.getPseudoMobility(board, white) - this.getPseudoMobility(board, black)) * this.params.mobilityWeight;
  }

  getPseudoMobility(board, clr) {
    const allies = board.getAllies(clr);
    const enemies = board.getEnemies(clr);
    const occupied = board.piecesBB;
    let mobility = 0;

    const countPieceMoves = (pieces, getMoves) => {
      let bb = pieces;
      while (bb) {
        const sqr = BBUtil.getLSBIndex(bb);
        mobility += BBUtil.countBits(getMoves(sqr) & ~allies.pieces);
        bb &= bb - 1n;
      }
    };

    countPieceMoves(allies.knights, (sqr) => BBUtil.knightMoves(sqr));
    countPieceMoves(allies.bishops, (sqr) => BBUtil.bishopMoves(sqr, occupied));
    countPieceMoves(allies.rooks, (sqr) => BBUtil.rookMoves(sqr, occupied));
    countPieceMoves(allies.queens, (sqr) => BBUtil.queenMoves(sqr, occupied));
    countPieceMoves(allies.king, (sqr) => BBUtil.kingMoves(sqr));

    let pawns = allies.pawns;
    const forward = clr == white ? -8 : 8;
    const startRank = clr == white ? 6 : 1;
    while (pawns) {
      const sqr = BBUtil.getLSBIndex(pawns);
      const oneForward = sqr + forward;
      if (BoardUtil.isValidSquare(oneForward) && !BBUtil.isBitSet(oneForward, occupied)) {
        mobility++;
        const twoForward = oneForward + forward;
        if (BoardUtil.squareToRank(sqr) == startRank && BoardUtil.isValidSquare(twoForward) && !BBUtil.isBitSet(twoForward, occupied)) mobility++;
      }
      mobility += BBUtil.countBits(BBUtil.pawnAttacks(sqr, clr) & enemies.pieces);
      pawns &= pawns - 1n;
    }
    return mobility;
  }

  getAttackMap(board, clr) {
    const pieces = board.getAllies(clr);
    const occupied = board.piecesBB;
    let attacks = 0n;
    const addAttacks = (bb, getMoves) => {
      while (bb) {
        const sqr = BBUtil.getLSBIndex(bb);
        attacks |= getMoves(sqr);
        bb &= bb - 1n;
      }
    };
    addAttacks(pieces.pawns, (sqr) => BBUtil.pawnAttacks(sqr, clr));
    addAttacks(pieces.knights, (sqr) => BBUtil.knightMoves(sqr));
    addAttacks(pieces.bishops, (sqr) => BBUtil.bishopMoves(sqr, occupied));
    addAttacks(pieces.rooks, (sqr) => BBUtil.rookMoves(sqr, occupied));
    addAttacks(pieces.queens, (sqr) => BBUtil.queenMoves(sqr, occupied));
    addAttacks(pieces.king, (sqr) => BBUtil.kingMoves(sqr));
    return attacks;
  }

  evaluateKingSafety(board) {
    const wKingSqr = BBUtil.getLSBIndex(board.white.king);
    const bKingSqr = BBUtil.getLSBIndex(board.black.king);
    const whiteDanger = this.getKingDanger(board, wKingSqr, white, this.getAttackMap(board, black));
    const blackDanger = this.getKingDanger(board, bKingSqr, black, this.getAttackMap(board, white));
    return blackDanger - whiteDanger;
  }

  getKingDanger(board, kingSqr, clr, enemyAttacks) {
    const allies = board.getAllies(clr);
    const allPawns = board.white.pawns | board.black.pawns;
    const kingFile = BoardUtil.squareToFile(kingSqr);
    const kingRank = BoardUtil.squareToRank(kingSqr);
    const forward = clr == white ? -1 : 1;
    let danger = 0;

    // Pawn shield directly in front of the king. Bounds checks keep this safe
    // for edge-rank positions as well as normal castled structures.
    const shieldRank = kingRank + forward;
    for (let file = kingFile - 1; file <= kingFile + 1; file++) {
      if (!BoardUtil.isValidSquare(file, shieldRank)) continue;
      const sqr = BoardUtil.indexToSquare(file, shieldRank);
      if (Piece.type(board.piecesList[sqr]) != pawn || Piece.clr(board.piecesList[sqr]) != clr) danger += this.params.kingShieldBonus;
    }

    // Semi-open and fully open files around the king are progressively worse.
    for (let file = kingFile - 1; file <= kingFile + 1; file++) {
      if (file < 0 || file > 7) continue;
      const fileMask = BBUtil.fileMasks[file];
      if ((fileMask & allies.pawns) == 0n) danger += this.params.semiOpenKingPenalty;
      if ((fileMask & allPawns) == 0n) danger += this.params.openFileNearKingPenalty;
    }

    const kingZone = BBUtil.kingMoves(kingSqr) | (1n << BigInt(kingSqr));
    danger += BBUtil.countBits(enemyAttacks & kingZone) * this.params.kingZoneAttackPenalty;
    return danger;
  }

  //Evaluates all pawns on the board in hopes of keeping a better pawn structure
  evaluatePawns(board, phase) {
    const whitePawns = board.white.pawns;
    const blackPawns = board.black.pawns;
    const occupied = board.piecesBB;
    let score = 0;

    // File-level defects are shared by all pawns on a file.
    for (let f = 0; f < 8; f++) {
      const wOnFile = whitePawns & BBUtil.fileMasks[f];
      const wOnFileCount = BBUtil.countBits(wOnFile);
      if (wOnFileCount > 1) score -= this.params.doubledPawnsPenalty * (wOnFileCount - 1);

      const bOnFile = blackPawns & BBUtil.fileMasks[f];
      const bOnFileCount = BBUtil.countBits(bOnFile);
      if (bOnFileCount > 1) score += this.params.doubledPawnsPenalty * (bOnFileCount - 1);
    }

    // Passed pawns become progressively more decisive as heavy pieces leave
    // the board.  The base bonus remains rank-dependent; this multiplier only
    // changes its importance between the middle- and endgame.
    const endgameProgress = (this.totalPhase - phase) / this.totalPhase;
    const passedPawnScale = 1 + endgameProgress * this.params.passedPawnEndgameScale;

    const evaluateSide = (pawns, enemyPawns, clr) => {
      let sideScore = 0;
      const forward = clr == white ? -8 : 8;

      // Build this once so connected passers can be identified with a single
      // adjacent-file mask probe per pawn rather than rescanning enemy pawns.
      let passedPawns = 0n;
      let candidates = pawns;
      while (candidates) {
        const sqr = BBUtil.getLSBIndex(candidates);
        if (this.isPassedPawn(sqr, clr, enemyPawns)) passedPawns |= 1n << BigInt(sqr);
        candidates &= candidates - 1n;
      }

      let bb = pawns;
      while (bb) {
        const sqr = BBUtil.getLSBIndex(bb);
        bb &= bb - 1n;
        const adjacentFiles = this.getAdjacentFileMask(sqr);
        if ((pawns & adjacentFiles) == 0n) sideScore -= this.params.isolatedPawnPenalty;

        // A pawn is protected when a friendly pawn attacks its square.
        const defenders = BBUtil.pawnAttacks(sqr, clr == white ? black : white);
        const protectedPawn = (pawns & defenders) != 0n;
        if (protectedPawn) sideScore += this.params.defendedPawnBonus;

        if ((passedPawns & (1n << BigInt(sqr))) != 0n) {
          const advance = clr == white ? BoardUtil.squareToRank(sqr) : 7 - BoardUtil.squareToRank(sqr);
          sideScore += this.params.passedPawnBonuses[advance] * passedPawnScale;
          if (protectedPawn) sideScore += this.params.protectedPassedPawnBonus;
          if ((passedPawns & adjacentFiles) != 0n) sideScore += this.params.connectedPassedPawnBonus;
        }

        // Any piece directly ahead blocks the pawn; stacked pawns are included.
        const forwardSqr = sqr + forward;
        if (BoardUtil.isValidSquare(forwardSqr) && BBUtil.isBitSet(forwardSqr, occupied)) sideScore -= this.params.blockedPawnPenalty;
        if (this.isBackwardPawn(sqr, clr, pawns, enemyPawns, occupied)) sideScore -= this.params.backwardPawnPenalty;
      }
      return sideScore;
    };

    score += evaluateSide(whitePawns, blackPawns, white);
    score -= evaluateSide(blackPawns, whitePawns, black);

    return score;
  }

  isPassedPawn(pawnSqr, pawnClr, enemyPawns) {
    return (BBUtil.passedPawnMasks[pawnClr][pawnSqr] & enemyPawns) === 0n;
  }

  getAdjacentFileMask(sqr) {
    const file = BoardUtil.squareToFile(sqr);
    let mask = 0n;
    if (file > 0) mask |= BBUtil.fileMasks[file - 1];
    if (file < 7) mask |= BBUtil.fileMasks[file + 1];
    return mask;
  }

  isBackwardPawn(pawnSqr, pawnClr, allyPawns, enemyPawns, occupied) {
    const forward = pawnClr == white ? -8 : 8;
    const forwardSqr = pawnSqr + forward;
    if (!BoardUtil.isValidSquare(forwardSqr) || BBUtil.isBitSet(forwardSqr, occupied)) return false;

    const adjacentFiles = this.getAdjacentFileMask(pawnSqr);
    const rank = BoardUtil.squareToRank(pawnSqr);
    const enemyClr = pawnClr == white ? black : white;

    // A supporting pawn must be on an adjacent file at the same rank or
    // behind this pawn.  The opponent's precomputed passed-pawn mask points
    // exactly in that direction; rankMasks adds the same-rank candidates.
    const supportMask = (BBUtil.passedPawnMasks[enemyClr][pawnSqr] | BBUtil.rankMasks[rank]) & adjacentFiles;
    if ((allyPawns & supportMask) != 0n) return false;

    // Reverse pawn attacks are also a precomputed lookup: using our colour
    // from the advance square yields the squares occupied by enemy pawns that
    // control it.  The pawn is backward only when that advance is unsafe.
    const enemyPawnAttackers = BBUtil.pawnAttacks(forwardSqr, pawnClr);
    return (enemyPawns & enemyPawnAttackers) != 0n;
  }

  isOutpost(knightSqr, knightClr, board) {
    //If the knight has no enemy pawns in front of it and has two allies defending it
    //We have an outpost

    const allyPawns = knightClr == white ? board.white.pawns : board.black.pawns;
    const enemyPawns = knightClr == white ? board.black.pawns : board.white.pawns;
    const otherClr = knightClr == white ? black : white;
    const knightFile = BoardUtil.squareToFile(knightSqr);
    const knightFileMask = BBUtil.fileMasks[knightFile];

    const enemyPawnsMask = BBUtil.passedPawnMask(knightSqr, knightClr) & ~knightFileMask;
    const pawnDefendersMask = BBUtil.pawnAttacks(knightSqr, otherClr);
    return (enemyPawnsMask & enemyPawns) == 0n && (pawnDefendersMask & allyPawns) != 0n;
  }

  //Initializes constants unique to the bot
  initialize() {
    //Standard piece values (none, pawns, knights, bishops, rooks, queens, king)
    this.pieceValues = [0, 100, 300, 320, 500, 900, 0];
    this.seePieceValues = [0, 100, 300, 320, 500, 900, 10000];

    //Parameters tuned with an SPSA and rounded to nearest integer
    this.params = {
      isolatedPawnPenalty: 15,
      defendedPawnBonus: 5,
      doubledPawnsPenalty: 20,
      kingShieldBonus: 5,
      protectedPassedPawnBonus: 12,
      semiOpenKingPenalty: 10,
      kingZoneAttackPenalty: 4,
      myTurnBonus: 10,
      bishopPairBonus: 30,
      kingMobilityPenalty: 1,
      rookOpenFileBonus: 30,
      connectedRooksBonus: 20,
      blockedPawnPenalty: 15,
      backwardPawnPenalty: 12,
      connectedPassedPawnBonus: 18,
      passedPawnEndgameScale: 0.6,
      openFileNearKingPenalty: 5,
      mobilityWeight: 2,
      outpostBonus: 10,

      //Bonus based on # of squares to first or last rank
      passedPawnBonuses: [0, 80, 50, 40, 30, 20, 20, 0],
    };

    this.mateScore = 10000000;
    this.maxExtensions = 16;
    this.killerMoves = Array.from({ length: 64 }, () => [null, null]);
    this.historyHeuristic = Array.from({ length: 7 }, () => Array(64).fill(0));

    // Fixed-size, direct-mapped transposition table. A power-of-two size keeps
    // probes O(1) and bounds memory regardless of how many searches are run.
    this.ttSize = 1 << 17;
    this.ttMask = BigInt(this.ttSize - 1);
    this.ttGeneration = 0;
    this.transpositionTable = new Array(this.ttSize);

    //How much each piece contributes to the "middlegame phase"
    this.phaseValues = [0, 0, 1, 1, 2, 4, 0];
    //The maximum phase value (when all pieces are still on the board)
    this.totalPhase = 24;

    /*PieceSquare tables*/
    //Initialized from white's point of view but indeces get mirrored in evaluation if black

    this.pawnEarlyPST = [
      0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5,
      -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0,
    ];

    this.pawnEndPST = [
      0, 0, 0, 0, 0, 0, 0, 0, 80, 80, 80, 80, 80, 80, 80, 80, 50, 50, 50, 50, 50, 50, 50, 50, 30, 30, 30, 30, 30, 30, 30, 30, 20, 20, 20, 20, 20, 20,
      20, 20, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0,
    ];

    this.knightPST = [
      -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0,
      15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50,
    ];

    this.bishopPST = [
      -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10,
      10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20,
    ];

    this.rookPST = [
      0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0,
      0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0,
    ];

    this.queenPST = [
      -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20,
    ];

    this.kingEarlyPST = [
      -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50,
      -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10,
      30, 20,
    ];

    this.kingEndPST = [
      -50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10,
      -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30,
      -50,
    ];
  }
}
