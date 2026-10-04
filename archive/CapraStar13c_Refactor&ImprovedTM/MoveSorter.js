import { BoardUtil } from "../BoardUtil.js";
import { BBUtil } from "../BBUtil.js";
import { Piece } from "../Piece.js";
import { Move } from "../Move.js";
import { white, black, none, pawn, knight, bishop, rook, queen, king, enPassantFlag } from "../Constants.js";

// Move ordering, static exchange evaluation, and move-ordering heuristics.
export class MoveSorter {
  constructor(engine) {
    this.engine = engine;
    this.resetHeuristics();
  }

  resetHeuristics() {
    this.resetKillers();
    this.historyHeuristic = Array.from({ length: 7 }, () => Array(64).fill(0));
  }

  resetKillers() {
    this.killerMoves = Array.from({ length: 64 }, () => [null, null]);
  }
  //Generates the "value" of a capture move
  //Capturing a queen with a pawn is usually preferable over capturing a pawn with a queen
  getMVVLVA(move, board) {
    const attackerPiece = board.piecesList[Move.startSqr(move)];
    const victimType = Move.capturePieceType(move, board);
    const attackerType = Piece.type(attackerPiece);

    if (victimType == none) return 0;
    return this.engine.seePieceValues[victimType] * 10 - this.engine.seePieceValues[attackerType];
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
        promoBonus = this.engine.seePieceValues[queen] - this.engine.seePieceValues[pawn];
      }
    }

    // Remove the LVA from occupancy â€” it moves to targetSqr
    const newOcc = occupancy & ~(1n << BigInt(lva.sqr));
    // Recompute attacker map: any X-ray slider behind the LVA is now revealed
    const newAttackers = board.getAttackersTo(targetSqr, newOcc);

    const gainIfCapture = this.engine.seePieceValues[pieceType] + promoBonus;
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
        promoBonus = this.engine.seePieceValues[queen] - this.engine.seePieceValues[pawn];
      }
    }

    // Remove the initial attacker from occupancy (it moves to targetSqr)
    const newOcc = BBUtil.unsetBit(attackerSqr, board.piecesBB);
    // Build the full attacker map from the resulting position
    const attackers = board.getAttackersTo(targetSqr, newOcc);

    // Let the opponent recapture optimally; their best gain determines our net score
    const opponentSide = board.clrToMove === white ? black : white;
    const opponentBitboards = opponentSide === white ? board.white : board.black;

    // A king cannot legally capture onto a defended square (cannot move into check)
    if (attackerType === king) {
      if ((attackers & opponentBitboards.pieces & newOcc) !== 0n) {
        return -this.engine.seePieceValues[king];
      }
    }

    const opponentGain = this.seeRecapture(targetSqr, effectiveAttackerType, newOcc, attackers, opponentSide, board);

    return this.engine.seePieceValues[capturedType] + promoBonus - opponentGain;
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

    const ttEntry = this.engine.transpositionTable.probe(board, this.engine.transpositionTable.getKey(board));
    const ttMove = ttEntry ? ttEntry.bestMoveLocal || ttEntry.bestMove : null;

    // The PV move expected at this ply (from the previous completed iteration)
    const pvMoveAtThisPly = this.engine.principalVariation && this.engine.principalVariation.length > ply ? this.engine.principalVariation[ply] : null;

    const scores = new Int32Array(len);
    const killer0 = this.killerMoves[ply][0];
    const killer1 = this.killerMoves[ply][1];

    for (let i = 0; i < len; i++) {
      const m = moves[i];
      let score = 0;

      //Looking at the principal variation (pv) from shallower searches first for iterative deepening
      if (pvMoveAtThisPly && m === pvMoveAtThisPly && depth === this.engine.currentSearchDepth) {
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

}
