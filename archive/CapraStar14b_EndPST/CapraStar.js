import { BoardUtil } from "../BoardUtil.js";
import { Piece } from "../Piece.js";
import { Move } from "../Move.js";
import { pawn } from "../Constants.js";
import { MoveGenerator } from "../MoveGenerator.js";
import { Evaluator } from "./Evaluator.js";
import { MoveSorter } from "./MoveSorter.js";
import { TranspositionTable } from "./TranspositionTable.js";
import { TimeManager } from "./TimeManager.js";

/* 🐐 CapraStar - The Greatest of All Tactics 🐐 */
/* This bot will for sure checkmaaaaate you */
//CapraStar
//V 14b

const DEFAULT_YIELD_EVERY_NODES = 2048;
//CapraStar bot implementation
class SearchTimeout extends Error {}

export class CapraStar {
  constructor(board) {
    this.board = board;
    this.moveGen = new MoveGenerator();
    this.evaluator = new Evaluator();
    this.moveSorter = new MoveSorter(this);
    this.mateScore = 10000000;
    this.maxExtensions = 16;

    this.transpositionTable = new TranspositionTable(1 << 17, this.mateScore);

    this.timeManager = new TimeManager(this.mateScore);
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

  // Preserve the engine's existing tuning and search-value interfaces while
  // keeping their ownership in the evaluator.
  get params() {
    return this.evaluator.params;
  }

  get pieceValues() {
    return this.evaluator.pieceValues;
  }

  get seePieceValues() {
    return this.evaluator.seePieceValues;
  }

  get killerMoves() {
    return this.moveSorter.killerMoves;
  }

  get historyHeuristic() {
    return this.moveSorter.historyHeuristic;
  }

  get searchDeadline() {
    return this.timeManager.searchDeadline;
  }

  get searchSoftDeadline() {
    return this.timeManager.searchSoftDeadline;
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
    this.timeManager.startSearch(timeLimitMs, legalMoves, this.board);
    this.maxDepthReached = 0;
    // Seed the count table from positions played before the search. Search
    // nodes increment/decrement their position in constant time.
    this.repetitionCounts.clear();
    for (const zobrist of this.board.repetitionHistory) this.pushRepetition(zobrist);

    // Age TT entries once per root search. Entries are retained across moves;
    // the fixed-size replacement table evicts stale, shallow collisions.
    this.transpositionTable.beginSearch();
    this.moveSorter.resetKillers();
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
        if (this.timeManager.shouldStopAfterCompletedDepth(score, performance.now() - iterationStart)) break;

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

  // Pondering receives its normal clock allocation only after ponderhit.
  setSearchTimeLimit(timeLimitMs) {
    this.timeManager.setSearchTimeLimit(timeLimitMs);
  }

  estimateRootComplexity(legalMoves) {
    return this.timeManager.estimateRootComplexity(legalMoves, this.board);
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

    const transpositionKey = this.transpositionTable.getKey(this.board);
    const entry = this.transpositionTable.probe(this.board, transpositionKey, ply);
    //If we have seen this position from a different move order before fetch the refutation score and its principal variation
    if (entry && entry.depth >= depth) {
      const ttScore = entry.bestScore;
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
    const nodeInCheck = this.moveGen.inCheck;

    moves = this.moveSorter.sortMoves(moves, this.board, this.moveGen.enemyPawnAttacksMask, depth, ply);

    // At shallow, non-PV nodes a quiet move cannot reasonably raise alpha
    // when even the static evaluation plus a conservative margin falls short.
    // Tactical moves are still searched below, after their check status is
    // known.  The evaluator score already uses the side-to-move perspective,
    // so it is directly comparable to alpha in negamax.
    const canUseFutility =
      ply > 0 && depth <= 3 && !nodeInCheck && beta - alph === 1 && this.evaluator.evaluate(this.board) + this.params.futilityMargins[depth] <= alph;

    let bestScore = -Infinity;
    let bestMoveLocal = moves[0];
    let bestPV = [];
    let searchedMoves = 0;

    for (let moveIndex = 0; moveIndex < moves.length; moveIndex++) {
      const move = moves[moveIndex];
      const isQuiet = !Move.isCapture(move, this.board) && !Move.isPromotion(move);
      this.board.makeMove(move, true);
      this.pushRepetition(this.board.zobristKey);

      const givesCheck = this.board.inCheck();
      const movedPiece = this.board.piecesList[Move.targetSqr(move)];
      const targetRank = BoardUtil.squareToRank(Move.targetSqr(move));
      const isNearPromotion = Piece.type(movedPiece) == pawn && (targetRank == 1 || targetRank == 6);

      // Do not discard quiet checks or dangerous pawn advances. They can
      // exceed a static futility margin by forcing a tactical response.
      if (canUseFutility && isQuiet && !givesCheck && !isNearPromotion) {
        this.popRepetition(this.board.zobristKey);
        this.board.unmakeMove(move, true);
        continue;
      }

      searchedMoves++;

      //Extending searches for checks and pawns about to promote
      let extensions = 0;
      if (currExtensions < this.maxExtensions) {
        if (givesCheck) extensions = 1;
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

        this.transpositionTable.store(
          this.board,
          transpositionKey,
          {
            depth,
            bestScore,
            flag: "BETA",
            bestMoveLocal,
            pv: bestPV,
          },
          ply,
        );
        return { score: bestScore, pv: bestPV };
      }
    }

    // All legal moves may have been quiet futile moves. This is a proven
    // fail-low node, so return alpha rather than propagating -Infinity.
    if (searchedMoves === 0) return { score: alph, pv: [] };

    //Storing refutation score on transposition table along its principal variation
    const flag = bestScore <= firstAlpha ? "ALPHA" : "EXACT";

    this.transpositionTable.store(
      this.board,
      transpositionKey,
      {
        depth,
        bestScore,
        flag,
        bestMoveLocal,
        pv: bestPV,
      },
      ply,
    );

    return { score: bestScore, pv: bestPV };
  }

  isMateScore(score) {
    return Math.abs(score) > this.mateScore - 1000; //Near mate
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

      evasions = this.moveSorter.sortMoves(evasions, this.board, this.moveGen.enemyPawnAttacksMask, 0, ply);
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
    const evaluation = this.evaluator.evaluate(this.board);
    let bestValue = evaluation;
    if (bestValue >= beta) return bestValue;
    if (bestValue > alph) alph = bestValue;

    const deltaMargin = 50;
    let captureMoves = this.moveGen.generateMoves(this.board, true);
    captureMoves = this.moveSorter.sortQuiescenceMoves(captureMoves, this.board);

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
}
