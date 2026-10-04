// Move ordering, static exchange evaluation, and move-ordering heuristics.
class MoveSorter {
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

  createSeeState(board) {
    return {
      occupied: board.piecesBB,
      white: [0n, board.white.pawns, board.white.knights, board.white.bishops, board.white.rooks, board.white.queens, board.white.king],
      black: [0n, board.black.pawns, board.black.knights, board.black.bishops, board.black.rooks, board.black.queens, board.black.king],
    };
  }

  getSeePieces(state, clr) {
    return clr === white ? state.white : state.black;
  }

  getSeeAttackersTo(targetSqr, state) {
    const whitePieces = state.white;
    const blackPieces = state.black;
    const whitePawns = BBUtil.pawnAttacks(targetSqr, black) & whitePieces[pawn];
    const blackPawns = BBUtil.pawnAttacks(targetSqr, white) & blackPieces[pawn];
    const knights = BBUtil.knightMoves(targetSqr) & (whitePieces[knight] | blackPieces[knight]);
    const diagonals =
      BBUtil.bishopMoves(targetSqr, state.occupied) & (whitePieces[bishop] | whitePieces[queen] | blackPieces[bishop] | blackPieces[queen]);
    const orthogonals =
      BBUtil.rookMoves(targetSqr, state.occupied) & (whitePieces[rook] | whitePieces[queen] | blackPieces[rook] | blackPieces[queen]);
    const kings = BBUtil.kingMoves(targetSqr) & (whitePieces[king] | blackPieces[king]);
    return whitePawns | blackPawns | knights | diagonals | orthogonals | kings;
  }

  isSeeSquareAttacked(targetSqr, attackingClr, state) {
    const attackers = this.getSeeAttackersTo(targetSqr, state);
    const pieces = this.getSeePieces(state, attackingClr);
    return (attackers & (pieces[pawn] | pieces[knight] | pieces[bishop] | pieces[rook] | pieces[queen] | pieces[king])) !== 0n;
  }

  makeSeeCapture(state, side, attackerSqr, attackerType, targetSqr, capturedType, effectiveAttackerType) {
    const ownPieces = this.getSeePieces(state, side).slice();
    const enemySide = side === white ? black : white;
    const enemyPieces = this.getSeePieces(state, enemySide).slice();
    const attackerMask = 1n << BigInt(attackerSqr);
    const targetMask = 1n << BigInt(targetSqr);

    ownPieces[attackerType] &= ~attackerMask;
    enemyPieces[capturedType] &= ~targetMask;
    ownPieces[effectiveAttackerType] |= targetMask;

    return {
      occupied: (state.occupied & ~attackerMask) | targetMask,
      white: side === white ? ownPieces : enemyPieces,
      black: side === black ? ownPieces : enemyPieces,
    };
  }

  getEffectiveSeeType(pieceType, side, targetSqr) {
    if (pieceType !== pawn) return pieceType;
    const rank = BoardUtil.squareToRank(targetSqr);
    return (side === white && rank === 0) || (side === black && rank === 7) ? queen : pawn;
  }

  // Returns the least valuable legal attacker. Pinned pieces are skipped and
  // king captures use the same post-move attack test, so opened x-rays are
  // handled correctly as well.
  getLeastLegalSeeAttacker(targetSqr, side, state) {
    const attackers = this.getSeeAttackersTo(targetSqr, state);
    const ownPieces = this.getSeePieces(state, side);
    const enemySide = side === white ? black : white;

    for (const attackerType of [pawn, knight, bishop, rook, queen, king]) {
      let candidates = attackers & ownPieces[attackerType];
      while (candidates) {
        const attackerSqr = BBUtil.getLSBIndex(candidates);
        const effectiveAttackerType = this.getEffectiveSeeType(attackerType, side, targetSqr);
        const nextState = this.makeSeeCapture(state, side, attackerSqr, attackerType, targetSqr, state.targetPieceType, effectiveAttackerType);
        const kingSqr = BBUtil.getLSBIndex(this.getSeePieces(nextState, side)[king]);
        if (kingSqr !== -1 && !this.isSeeSquareAttacked(kingSqr, enemySide, nextState)) {
          return { attackerType, effectiveAttackerType, nextState };
        }
        candidates &= candidates - 1n;
      }
    }
    return null;
  }

  // Recursive SEE helper: returns the best gain the current side can make by
  // a legal recapture. targetPieceType is updated after every virtual move.
  seeRecapture(targetSqr, side, state) {
    const recapture = this.getLeastLegalSeeAttacker(targetSqr, side, state);
    if (recapture === null) return 0;

    const promotionBonus = this.engine.seePieceValues[recapture.effectiveAttackerType] - this.engine.seePieceValues[recapture.attackerType];
    recapture.nextState.targetPieceType = recapture.effectiveAttackerType;
    const opponentGain = this.seeRecapture(targetSqr, side === white ? black : white, recapture.nextState);
    return Math.max(0, this.engine.seePieceValues[state.targetPieceType] + promotionBonus - opponentGain);
  }

  // Static Exchange Evaluation.
  // Estimates the net material gain for `board.clrToMove` from the initial capture of
  // `capturedType` on `targetSqr` with the `attackerType` piece from `attackerSqr`.
  // Positive = winning/equal trade; negative = losing trade.
  see(targetSqr, capturedType, attackerSqr, attackerType, board) {
    const side = board.clrToMove;
    const effectiveAttackerType = this.getEffectiveSeeType(attackerType, side, targetSqr);
    const state = this.makeSeeCapture(this.createSeeState(board), side, attackerSqr, attackerType, targetSqr, capturedType, effectiveAttackerType);
    state.targetPieceType = effectiveAttackerType;

    const promotionBonus = this.engine.seePieceValues[effectiveAttackerType] - this.engine.seePieceValues[attackerType];
    const opponentGain = this.seeRecapture(targetSqr, side === white ? black : white, state);
    return this.engine.seePieceValues[capturedType] + promotionBonus - opponentGain;
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
    const pvMoveAtThisPly =
      this.engine.principalVariation && this.engine.principalVariation.length > ply ? this.engine.principalVariation[ply] : null;

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
