/* 🐐 CapraStar - The Greatest of All Tactics 🐐 */
/* This bot will for sure checkmaaaaate you */
//CapraStar
//V 10 (minus mobility eval)

//Web worker script for the AI to run in parallel to the UI
importScripts(
  `BoardUtil.js?v=${Date.now()}`,
  `Perft.js?v=${Date.now()}`,
  `Constants.js?v=${Date.now()}`,
  `BBUtil.js?v=${Date.now()}`,
  `Piece.js?v=${Date.now()}`,
  `Zobrist.js?v=${Date.now()}`,
  `GameState.js?v=${Date.now()}`,
  `Board.js?v=${Date.now()}`,
  `Move.js?v=${Date.now()}`,
  `MoveGenerator.js?v=${Date.now()}`,
);

let capraStar = null;
let book = {}; //Map of book moves passed from sketch.js
let pendingSearch = null;
let searchRunning = false;
let pendingEvaluation = null;
let evaluatorRunning = false;

function getTimeBudgetMs(timeRemainingMs) {
  // Spend a portion of the time remaining so the UI stays responsive,
  // while still using enough search time to find a sane move.
  if (!Number.isFinite(timeRemainingMs) || timeRemainingMs <= 0) {
    return 100000;
  }

  const budget = Math.min(timeRemainingMs * 0.1, 4000);
  postMessage({
    msg: "remaining: " + timeRemainingMs * 0.1 + " limit: " + budget,
  });

  return Math.max(100, budget);
}

onmessage = async function (e) {
  const { type, fen } = e.data;
  const timeBudgetMs = getTimeBudgetMs(Number(e.data.timeRemainingMs) || 0);
  const requestId = e.data.requestId;
  const positionGeneration = e.data.positionGeneration;
  switch (type) {
    case "init":
      book = e.data.book;
      capraStar = new CapraStar(new Board());
      break;
    case "search":
      if (!capraStar) capraStar = new CapraStar(new Board());
      //A player can undo while a search is in flight, then play a different move.
      //Keep only that newest position and cancel the superseded search before it can
      //mutate the shared board again.
      pendingSearch = { fen, timeBudgetMs, requestId, positionGeneration, repetitionHistory: e.data.repetitionHistory };
      capraStar.cancelSearch();
      processSearchQueue();
      break;
    case "evaluate":
      if (!capraStar) capraStar = new CapraStar(new Board());
      pendingEvaluation = { fen, timeBudgetMs, requestId, positionGeneration, repetitionHistory: e.data.repetitionHistory };
      capraStar.cancelSearch();
      processEvaluationQueue();
      break;
  }
};

async function processSearchQueue() {
  if (searchRunning) return;
  searchRunning = true;

  try {
    while (pendingSearch) {
      const request = pendingSearch;
      pendingSearch = null;

      //Empty CapraStar's copy of the board and reconstruct the requested position.
      capraStar.board.init();
      capraStar.board.fillBoard(request.fen);
      capraStar.positionHistory = request.repetitionHistory;

      const legalMoves = capraStar.moveGen.generateMoves(capraStar.board);
      const start = performance.now();
      await capraStar.getBestMove(legalMoves, request.timeBudgetMs);

      //If another request arrived, this result belongs to an abandoned position.
      if (pendingSearch) continue;

      postMessage({
        type: "result",
        bestMove: capraStar.bestMoveFound,
        evaluation: capraStar.evaluation,
        depth: capraStar.maxDepthReached ?? 0,
        requestId: request.requestId,
        positionGeneration: request.positionGeneration,
        timeTaken: performance.now() - start,
      });
    }
  } finally {
    searchRunning = false;
    if (pendingSearch) processSearchQueue();
  }
}

async function processEvaluationQueue() {
  if (evaluatorRunning) return;
  evaluatorRunning = true;

  try {
    while (pendingEvaluation) {
      const request = pendingEvaluation;
      pendingEvaluation = null;

      capraStar.board.init();
      capraStar.board.fillBoard(request.fen);
      capraStar.positionHistory = request.repetitionHistory;
      const moves = capraStar.moveGen.generateMoves(capraStar.board);
      const start = performance.now();

      await capraStar.getBestMove(moves, request.timeBudgetMs, (depthInfo) => {
        postMessage({
          type: "evaluation",
          bestMove: depthInfo.bestMove,
          evaluation: depthInfo.score,
          pv: depthInfo.pv,
          timeTaken: performance.now() - start,
          depth: depthInfo.depth,
          requestId: request.requestId,
          positionGeneration: request.positionGeneration,
          fen: request.fen,
        });
      });
    }
  } finally {
    evaluatorRunning = false;
    if (pendingEvaluation) processEvaluationQueue();
  }
}

function getBookMove(board) {
  const fen = board.toFEN(false, false) + " -";
  const moves = book[fen];

  if (moves) {
    // Pick a random move from the book
    const pickedMove = moves[Math.floor(Math.random() * moves.length)];
    return Move.UCIToMove(pickedMove, board);
  }
  return null;
}

//CapraStar bot implementation
class SearchTimeout extends Error {}

class CapraStar {
  constructor(board) {
    this.board = board;
    this.moveGen = new MoveGenerator();
    this.initialize(); //Contains constants the bot uses like piece-square tables, etc

    this.searchDeadline = Infinity;
    this.searchCancelled = false;
    this.nodesSinceYield = 0;
    this.yieldEveryNodes = 1024;
    //Holds the best move found on every turn
    this.bestMoveFound = 0;
    //Holds the evaluation of the current position after a search
    this.evaluation = 0;
    //Max depth on the current search
    this.maxDepthReached = 0;
    //Holds the current principal variation after a search (list of best moves for either side up to a certain depth)
    this.principalVariation = [];
    //Stack to keep track of position seen in this line to detect draws by repetition
    this.positionHistory = [];
  }

  //Receives list of legal moves and returns the best one
  async getBestMove(legalMoves, timeLimitMs = 1500, onDepthCompleted = null) {
    //Attempting to get a book move without searching
    const bookMove = getBookMove(this.board);

    this.bestMoveFound = legalMoves[0]; //If for some reason no move is found play the first
    this.principalVariation = [];
    this.searchCancelled = false;
    this.nodesSinceYield = 0;
    this.searchDeadline = Number.isFinite(timeLimitMs) ? performance.now() + timeLimitMs : Infinity;
    this.maxDepthReached = 0;

    const maxDepth = 10;

    //Iterative deepening. Performing a search from a depth of 1 all the way up to a depth of maxDepth
    //This is done to keep track of the best moves at every depth and look at those first on the next depth to prune more branches
    for (let depth = 1; depth <= maxDepth; depth++) {
      this.currentSearchDepth = depth;
      try {
        const { score, pv } = await this.negaMax(-Infinity, Infinity, depth, 0, 0);
        this.evaluation = score;
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
          });
        }

        // Give the main thread time to receive and render this depth's result.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } catch (error) {
        if (error instanceof SearchTimeout) {
          this.searchCancelled = true;
          this.maxDepthReached = this.currentSearchDepth;
          break;
        }
        throw error;
      }
    }

    //If there is a book move play that instead. Do it after a search to make the bot more human in the opening instead of playing immediately
    if (bookMove) this.bestMoveFound = bookMove;
  }

  cancelSearch() {
    this.searchCancelled = true;
  }

  async checkSearchState() {
    if (this.searchCancelled || (Number.isFinite(this.searchDeadline) && performance.now() >= this.searchDeadline)) {
      this.searchCancelled = true;
      throw new SearchTimeout("Search cancelled");
    }

    if (++this.nodesSinceYield % this.yieldEveryNodes === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.searchCancelled || (Number.isFinite(this.searchDeadline) && performance.now() >= this.searchDeadline)) {
        this.searchCancelled = true;
        throw new SearchTimeout("Search cancelled");
      }
    }
  }

  isRepetition() {
    const currKey = this.board.zobristKey;
    let count = 0;
    for (let zobrist of this.positionHistory) {
      if (zobrist == currKey) count++;
    }
    //Detecting repetition if the position has appeared twice (current position and some previous time)
    return count >= 2;
  }

  //Main search function. Returns the evaluation of the position being searched
  //as well as the principal variation (best moves for either side on a given position)
  async negaMax(alph, beta, depth, ply, currExtensions) {
    await this.checkSearchState();

    if (ply > 0) {
      //Returns draw evaluation if 50 move counter reached
      if (this.board.plyCounter == 100) return { score: 0, pv: [] };
      //Returns draw evaluation if it is a repetition
      if (this.isRepetition()) return { score: 0, pv: [] };

      //If forced mate has been found already stop searching
      alph = Math.max(alph, -this.mateScore + ply);
      beta = Math.min(beta, this.mateScore - ply);
      if (alph >= beta) return { score: alph, pv: [] };
    }

    const zobristHash = this.board.zobristKey;
    const entry = this.transpositionTable.get(zobristHash);
    //If we have seen this position from a different move order before fetch the refutation score and its principal variation
    if (entry && entry.depth >= depth) {
      const ttScore = this.adjustMateScoreForRetrieval(entry.bestScore, ply);
      if (ply == 0 && entry.bestMoveLocal) this.bestMoveFound = entry.bestMoveLocal;

      if (entry.flag === "EXACT") return { score: ttScore, pv: entry.pv || [] };
      if (entry.flag === "ALPHA" && ttScore <= alph) return { score: alph, pv: entry.pv || [] };
      if (entry.flag === "BETA" && ttScore >= beta) return { score: beta, pv: entry.pv || [] };
    }

    //Base case when depth = 0, return the evaluation gotten from quiescence search and an empty principal variation
    if (depth == 0) {
      const qScore = await this.quiescence(alph, beta);
      return { score: qScore, pv: [] };
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

    moves = this.sortMoves(moves, this.board, this.moveGen.enemyPawnAttacksMask, depth, ply);

    let bestScore = -Infinity;
    let bestMoveLocal = moves[0];
    let bestPV = [];

    for (let move of moves) {
      this.board.makeMove(move, false);
      this.positionHistory.push(this.board.zobristKey);

      //Extending searches for checks and pawns about to promote
      let extensions = 0;
      if (currExtensions < this.maxExtensions) {
        if (this.board.inCheck()) extensions = 1;
        const movedPiece = this.board.piecesList[Move.targetSqr(move)];
        const targetRank = BoardUtil.squareToRank(Move.targetSqr(move));
        if (Piece.type(movedPiece) == pawn && (targetRank == 1 || targetRank == 6)) extensions = 1;
      }

      let child;
      try {
        child = await this.negaMax(-beta, -alph, depth - 1 + extensions, ply + 1, currExtensions + extensions);
      } finally {
        this.board.unmakeMove(move, false);
        this.positionHistory.pop();
      }
      const score = -child.score;

      if (score > bestScore) {
        bestScore = score;
        bestMoveLocal = move;
        //Appending the current best move to the principal variation
        bestPV = [move, ...child.pv];

        if (ply == 0) this.bestMoveFound = move;
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
        this.transpositionTable.set(zobristHash, {
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
    let flag;
    if (bestScore <= firstAlpha) flag = "ALPHA";
    else if (bestScore >= firstBeta) flag = "BETA";
    else flag = "EXACT";

    const storedScore = this.adjustMateScoreForStorage(bestScore, ply);
    this.transpositionTable.set(zobristHash, {
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
  async quiescence(alph, beta) {
    await this.checkSearchState();
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

      this.board.makeMove(capture, false);
      let score;
      try {
        score = -(await this.quiescence(-beta, -alph));
      } finally {
        this.board.unmakeMove(capture, false);
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
    return this.pieceValues[victimType] * 10 - this.pieceValues[attackerType];
  }

  //Sorts the capture moves in descending order to look at the best captures first during quiescence
  sortQuiescenceMoves(moves, board) {
    const scoredMoves = moves.map((m) => {
      //MVVLA capture heuristic
      let score = this.getMVVLVA(m, board);
      //Look at promotions first
      if (Move.isPromotion(m)) score += 20000;
      return { move: m, score };
    });
    return scoredMoves.sort((a, b) => b.score - a.score).map((e) => e.move);
  }

  //Sorts the moves in descending order to look at the best moves first during normal search
  sortMoves(moves, board, enemyPawnAttackMask, depth, ply = 0) {
    const ttEntry = this.transpositionTable.get(board.zobristKey);
    let ttMove = ttEntry ? ttEntry.bestMoveLocal || ttEntry.bestMove : null;

    // The PV move expected at this ply (from the previous completed iteration)
    const pvMoveAtThisPly = this.principalVariation && this.principalVariation.length > ply ? this.principalVariation[ply] : null;

    const scoredMoves = moves.map((m) => {
      // Start with MVV-LVA for captures
      let score = this.getMVVLVA(m, board);

      //Looking at the principal variation (pv) from shallower searches first for iterative deepening
      if (pvMoveAtThisPly && m == pvMoveAtThisPly && depth == this.currentSearchDepth) score += 900000;

      //Look at the best move of transpositions second
      if (ttMove && m == ttMove) score += 500000;

      //Killer moves in other branches
      if (this.killerMoves[ply].includes(m)) score += 10000;

      //Prioritize looking at promotions
      if (Move.isPromotion(m)) score += 20000;

      // History for quiet moves
      if (!Move.isCapture(m, board)) {
        const attacker = board.piecesList[Move.startSqr(m)];
        score += this.historyHeuristic[Piece.type(attacker)][Move.targetSqr(m)];
      }

      //Penalize moves for having a target square controlled by opponent pawns
      if (BBUtil.isBitSet(Move.targetSqr(m), enemyPawnAttackMask)) score -= 50;

      return { move: m, score };
    });

    return scoredMoves.sort((a, b) => b.score - a.score).map((e) => e.move);
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
          if (this.isOutpost(sqr, pieceClr, board)) pieceValue += this.outpostBonus;
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
          if ((rookFileMask & allPawnsBB) == 0n) pieceValue += this.rookOpenFileBonus;

          //Rewarding rooks being connected
          const allyRooks = pieceClr == white ? board.white.rooks : board.black.rooks;
          const blockersMask = board.piecesBB;

          //If the current rook sees an ally rook (they are connected)
          if ((BBUtil.rookMoves(sqr, blockersMask) & allyRooks) != 0n) pieceValue += this.connectedRooksBonus * 0.5; //Divide by 2 to avoid giving bonus twice
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
    if (hasBishop.light[white] && hasBishop.dark[white]) evaluation += this.bishopPairBonus;
    if (hasBishop.light[black] && hasBishop.dark[black]) evaluation -= this.bishopPairBonus;

    const pieceCount = board.pieceCounts[white][0] + board.pieceCounts[black][0];
    const wKingSquare = BBUtil.getLSBIndex(board.white.king);
    const bKingSquare = BBUtil.getLSBIndex(board.black.king);
    const blackIndex = BoardUtil.mirrorIndex(bKingSquare);

    //Detecting forced mate scenarios
    const whiteKRvsK = whiteMaterial == this.pieceValues[rook] && blackMaterial == 0;
    const blackKRvsK = blackMaterial == this.pieceValues[rook] && whiteMaterial == 0;
    const whiteKQvsK = whiteMaterial == this.pieceValues[queen] && blackMaterial == 0;
    const blackKQvsK = blackMaterial == this.pieceValues[queen] && whiteMaterial == 0;

    //When the endgame begins (arbitrarily less than 8 pieces for now) use mop-up scores
    if (pieceCount <= 8) {
      //Mop-up logic for endgames
      evaluation += this.calcMopUpScore(wKingSquare, bKingSquare, whiteMaterial, blackMaterial);
      evaluation -= this.calcMopUpScore(bKingSquare, wKingSquare, blackMaterial, whiteMaterial);
      if (whiteKRvsK || whiteKQvsK) {
        const distance = BoardUtil.manhattanDistances[bKingSquare][wKingSquare];
        const edgeDist = BoardUtil.distanceToCenter[bKingSquare];
        evaluation += 2000 - distance * 50 + edgeDist * 150;
      }
      if (blackKRvsK || blackKQvsK) {
        const distance = BoardUtil.manhattanDistances[wKingSquare][bKingSquare];
        const edgeDist = BoardUtil.distanceToCenter[wKingSquare];
        evaluation -= 2000 - distance * 50 + edgeDist * 150;
      }
    } else {
      //Giving penalty for the king having many legal moves (undefended king) when not in endgame
      const wKingMoves = BBUtil.queenMoves(wKingSquare, board.piecesBB);
      evaluation -= BBUtil.countBits(wKingMoves) * this.kingMobilityPenalty; //If white king has a lot of moves it is good for black
      const bKingMoves = BBUtil.queenMoves(bKingSquare, board.piecesBB);
      evaluation += BBUtil.countBits(bKingMoves) * this.kingMobilityPenalty; //If black king has a lot of moves it is good for white
      evaluation += this.evaluateKingSafety(board);

      //Small bonus for being the player to move (apparently counterproductive during endgames)
      evaluation += this.myTurnBonus * perspectiveMult;
    }

    //Evaluating quality of pawns for each side
    evaluation += this.evaluatePawns(board);
    //evaluation+=this.evaluateMobility(board);

    return evaluation * perspectiveMult;
  }

  calcMopUpScore(allyKingSqr, enemyKingSqr, allyMaterial, enemyMaterial) {
    //Only encourage to move the king closer if up material
    if (allyMaterial < enemyMaterial) return 0;

    let mopUpScore = 0;
    mopUpScore += (14 - BoardUtil.manhattanDistances[allyKingSqr][enemyKingSqr]) * 500;

    //Encourage moving opponent king to edges
    mopUpScore += BoardUtil.distanceToCenter[enemyKingSqr] * 100;

    return mopUpScore;
  }

  evaluateMobility(board) {
    //Temporarily save which side is to move
    const clrToMove = board.clrToMove;

    //Count mobility for White
    board.clrToMove = white;
    const whiteMoves = this.moveGen.generateMoves(board);
    const whiteMobility = whiteMoves.length;

    //Count mobility for Black
    board.clrToMove = black;
    const blackMoves = this.moveGen.generateMoves(board);
    const blackMobility = blackMoves.length;

    //Restore side to move
    board.clrToMove = clrToMove;

    //Positive score favors White
    const mobilityScore = (whiteMobility - blackMobility) * this.mobilityWeight;

    return mobilityScore;
  }

  evaluateKingSafety(board) {
    const wKingSqr = BBUtil.getLSBIndex(board.white.king);
    const bKingSqr = BBUtil.getLSBIndex(board.black.king);
    let score = 0;

    //Checking open files near white king
    const whiteKingFile = BoardUtil.squareToFile(wKingSqr);
    const whiteFileMask = BBUtil.fileMasks[whiteKingFile];
    const whiteLeftFileMask = whiteKingFile > 0 ? BBUtil.fileMasks[whiteKingFile - 1] : 18446744073709551615n;
    const whiteRightFileMask = whiteKingFile < 7 ? BBUtil.fileMasks[whiteKingFile + 1] : 18446744073709551615n;

    const whitePiecesNoKing = board.white.pieces & ~board.white.king;

    //Open file near the white king (no ally pieces blocking)
    if ((whiteFileMask & whitePiecesNoKing) == 0n) score -= this.openFileNearKingPenalty; //good for black
    if ((whiteLeftFileMask & whitePiecesNoKing) == 0n) score -= this.openFileNearKingPenalty; //good for black
    if ((whiteRightFileMask & whitePiecesNoKing) == 0n) score -= this.openFileNearKingPenalty; //good for black

    //Checking open files near black king
    const blackKingFile = BoardUtil.squareToFile(bKingSqr);
    const blackFileMask = BBUtil.fileMasks[blackKingFile];
    const blackLeftFileMask = blackKingFile > 0 ? BBUtil.fileMasks[blackKingFile - 1] : 18446744073709551615n;
    const blackRightFileMask = blackKingFile < 7 ? BBUtil.fileMasks[blackKingFile + 1] : 18446744073709551615n;

    const blackPiecesNoKing = board.black.pieces & ~board.black.king;
    if ((blackFileMask & blackPiecesNoKing) == 0n) score += this.openFileNearKingPenalty; //good for white
    if ((blackLeftFileMask & blackPiecesNoKing) == 0n) score += this.openFileNearKingPenalty; //good for white
    if ((blackRightFileMask & blackPiecesNoKing) == 0n) score += this.openFileNearKingPenalty; //good for white

    return score;
  }

  //Evaluates all pawns on the board in hopes of keeping a better pawn structure
  evaluatePawns(board) {
    const whitePawns = board.white.pawns;
    const blackPawns = board.black.pawns;
    let score = 0;
    //Doubled pawns (more than 1 pawn on a file)
    for (let f = 0; f < 8; f++) {
      const wOnFile = whitePawns & BBUtil.fileMasks[f];
      const wOnFileCount = BBUtil.countBits(wOnFile);
      if (wOnFileCount > 1) score -= this.doubledPawnsPenalty * (wOnFileCount - 1); //Double white pawns are good for black

      const bOnFile = blackPawns & BBUtil.fileMasks[f];
      const bOnFileCount = BBUtil.countBits(bOnFile);
      if (bOnFileCount > 1) score += this.doubledPawnsPenalty * (bOnFileCount - 1); //Double black pawns are good for white
    }

    //Evaluating white pawns
    let wp = whitePawns;
    while (wp) {
      const sqr = BBUtil.getLSBIndex(wp);
      wp &= wp - 1n;

      const file = BoardUtil.squareToFile(sqr);

      //Detecting isolated pawns (no pawns on adjacent files)
      let adjFiles = 0n;
      if (file > 0) adjFiles |= BBUtil.fileMasks[file - 1];
      if (file < 7) adjFiles |= BBUtil.fileMasks[file + 1];
      if ((whitePawns & adjFiles) === 0n) score -= this.isolatedPawnPenalty;

      //Detecting pawn chains (defended by another pawn diagonally behind)
      //If the current pawn was of the opposite color, would it be able to capture enemy pawns
      const supportMask = BBUtil.pawnAttacks(sqr, black);
      if (whitePawns & supportMask) score += this.defendedPawnBonus;

      //Detecting passed pawns and giving a bonus based on number of squares to end of the board
      if (this.isPassedPawn(sqr, white, blackPawns)) {
        const distanceToEdge = BoardUtil.squareToRank(sqr);
        score += this.passedPawnBonuses[distanceToEdge];
      }

      //Blocked pawns (ally piece in front)
      const forwardSqr = sqr - 8;
      const whitePiecesNoPawns = board.white.pieces & ~board.white.pawns;
      if (BBUtil.isBitSet(forwardSqr, whitePiecesNoPawns)) {
        score -= this.blockedPawnPenalty; //Good for black
      }
    }

    //Evaluating black pawns
    let bp = blackPawns;
    while (bp) {
      const sqr = BBUtil.getLSBIndex(bp);
      bp &= bp - 1n;

      const file = BoardUtil.squareToFile(sqr);

      //Isolated
      let adjFiles = 0n;
      if (file > 0) adjFiles |= BBUtil.fileMasks[file - 1];
      if (file < 7) adjFiles |= BBUtil.fileMasks[file + 1];
      if ((blackPawns & adjFiles) === 0n) score += this.isolatedPawnPenalty;

      //Pawn chains
      const supportMask = BBUtil.pawnAttacks(sqr, white);
      if (blackPawns & supportMask) score -= this.defendedPawnBonus;

      //Passed pawns
      if (this.isPassedPawn(sqr, black, whitePawns)) {
        const distanceToEdge = 7 - BoardUtil.squareToRank(sqr);
        score -= this.passedPawnBonuses[distanceToEdge];
      }

      //Blocked pawns (ally piece in front)
      const forwardSqr = sqr + 8;
      const blackPiecesNoPawns = board.black.pieces & ~board.black.pawns;
      if (BBUtil.isBitSet(forwardSqr, blackPiecesNoPawns)) {
        score += this.blockedPawnPenalty; //Good for white
      }
    }

    const wKingSqr = BBUtil.getLSBIndex(board.white.king);
    const bKingSqr = BBUtil.getLSBIndex(board.black.king);
    //Pawn shields (3 pawns in from of the king, +2 for every pawn found)
    const whiteShieldMask = ((1n << BigInt(wKingSqr - 7)) | (1n << BigInt(wKingSqr - 8)) | (1n << BigInt(wKingSqr - 9))) & 0xffffffffffffffffn;
    const blackShieldMask = ((1n << BigInt(bKingSqr + 7)) | (1n << BigInt(bKingSqr + 8)) | (1n << BigInt(bKingSqr + 9))) & 0xffffffffffffffffn;

    score += BBUtil.countBits(whitePawns & whiteShieldMask) * this.kingShieldBonus;
    score -= BBUtil.countBits(blackPawns & blackShieldMask) * this.kingShieldBonus;

    return score;
  }

  isPassedPawn(pawnSqr, pawnClr, enemyPawns) {
    return (BBUtil.passedPawnMasks[pawnClr][pawnSqr] & enemyPawns) == 0;
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

    //Bonus based on # of squares to first or last rank
    this.passedPawnBonuses = [0, 80, 50, 40, 30, 20, 20, 0];
    this.isolatedPawnPenalty = 15;
    this.defendedPawnBonus = 5;
    this.doubledPawnsPenalty = 20;
    this.kingShieldBonus = 5;
    this.myTurnBonus = 10;
    this.bishopPairBonus = 30;
    this.kingMobilityPenalty = 1;
    this.rookOpenFileBonus = 30;
    this.connectedRooksBonus = 20;
    this.blockedPawnPenalty = 15;
    this.openFileNearKingPenalty = 5;
    this.mobilityWeight = 2;
    this.outpostBonus = 10;

    this.mateScore = 10000000;
    this.maxExtensions = 16;
    this.killerMoves = Array.from({ length: 64 }, () => [null, null]);
    this.historyHeuristic = Array.from({ length: 7 }, () => Array(64).fill(0));

    this.transpositionTable = new Map();

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

