import { BoardUtil } from "../Chess_Components/BoardUtil.js";
import { BBUtil } from "../Chess_Components/BBUtil.js";
import { Piece } from "../Chess_Components/Piece.js";
import { white, black, pawn, knight, bishop, rook, queen, king } from "../Chess_Components/Constants.js";

// Position evaluation and all of its supporting heuristics.
export class Evaluator {
  constructor() {
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
      // Attacks in the king zone are not equally dangerous: a queen battery
      // matters much more than a pawn controlling a single escape square.
      kingZoneAttackWeights: [0, 1, 2, 2, 3, 4, 0],
      kingZoneMultiAttackerPenalty: 8,
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
      // Mobility is scored per destination square.  Minor pieces benefit most
      // from extra scope; queen mobility is deliberately cheap to avoid
      // rewarding premature queen excursions.
      mobilityWeights: [0, 1, 4, 4, 2, 1, 0],
      outpostBonus: 10,

      // Maximum plausible positional gain from a quiet move at shallow search
      // depths. Used by the search's futility-pruning test.
      futilityMargins: [0, 0, 120, 250, 400],

      //Bonus based on # of squares to first or last rank
      passedPawnBonuses: [0, 80, 50, 40, 30, 20, 20, 0],
    };

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

          // Reward rooks on open files, with half credit for a semi-open file
          // (no friendly pawn, but at least one opposing pawn remains).
          const allPawnsBB = board.white.pawns | board.black.pawns;
          const allyPawns = pieceClr == white ? board.white.pawns : board.black.pawns;
          const rookFile = BoardUtil.squareToFile(sqr);
          const rookFileMask = BBUtil.fileMasks[rookFile];
          if ((rookFileMask & allPawnsBB) == 0n) pieceValue += this.params.rookOpenFileBonus;
          else if ((rookFileMask & allyPawns) == 0n) pieceValue += this.params.rookOpenFileBonus * 0.5;

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
    return this.getPseudoMobility(board, white) - this.getPseudoMobility(board, black);
  }

  getPseudoMobility(board, clr) {
    const allies = board.getAllies(clr);
    const enemies = board.getEnemies(clr);
    const occupied = board.piecesBB;
    let mobility = 0;

    const countPieceMoves = (pieces, pieceType, getMoves) => {
      let bb = pieces;
      while (bb) {
        const sqr = BBUtil.getLSBIndex(bb);
        mobility += BBUtil.countBits(getMoves(sqr) & ~allies.pieces) * this.params.mobilityWeights[pieceType];
        bb &= bb - 1n;
      }
    };

    countPieceMoves(allies.knights, knight, (sqr) => BBUtil.knightMoves(sqr));
    countPieceMoves(allies.bishops, bishop, (sqr) => BBUtil.bishopMoves(sqr, occupied));
    countPieceMoves(allies.rooks, rook, (sqr) => BBUtil.rookMoves(sqr, occupied));
    countPieceMoves(allies.queens, queen, (sqr) => BBUtil.queenMoves(sqr, occupied));
    countPieceMoves(allies.king, king, (sqr) => BBUtil.kingMoves(sqr));

    let pawns = allies.pawns;
    const forward = clr == white ? -8 : 8;
    const startRank = clr == white ? 6 : 1;
    while (pawns) {
      const sqr = BBUtil.getLSBIndex(pawns);
      const oneForward = sqr + forward;
      if (BoardUtil.isValidSquare(oneForward) && !BBUtil.isBitSet(oneForward, occupied)) {
        mobility += this.params.mobilityWeights[pawn];
        const twoForward = oneForward + forward;
        if (BoardUtil.squareToRank(sqr) == startRank && BoardUtil.isValidSquare(twoForward) && !BBUtil.isBitSet(twoForward, occupied))
          mobility += this.params.mobilityWeights[pawn];
      }
      mobility += BBUtil.countBits(BBUtil.pawnAttacks(sqr, clr) & enemies.pieces) * this.params.mobilityWeights[pawn];
      pawns &= pawns - 1n;
    }
    return mobility;
  }

  evaluateKingSafety(board) {
    const wKingSqr = BBUtil.getLSBIndex(board.white.king);
    const bKingSqr = BBUtil.getLSBIndex(board.black.king);
    const whiteDanger = this.getKingDanger(board, wKingSqr, white);
    const blackDanger = this.getKingDanger(board, bKingSqr, black);
    return blackDanger - whiteDanger;
  }

  getKingDanger(board, kingSqr, clr) {
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
    const pressure = this.getKingZoneAttackPressure(board, clr == white ? black : white, kingZone);
    danger += pressure.units;

    // Coordinated attacks are more dangerous than the sum of isolated attacks.
    // Squaring the additional attackers gives a modest but meaningful ramp-up
    // without making a single minor-piece attack dominate the evaluation.
    if (pressure.attackers > 1) danger += (pressure.attackers - 1) ** 2 * this.params.kingZoneMultiAttackerPenalty;
    return danger;
  }

  getKingZoneAttackPressure(board, attackingClr, kingZone) {
    const attackers = board.getAllies(attackingClr);
    const occupied = board.piecesBB;
    let units = 0;
    let attackingPieces = 0;

    const addPressure = (pieces, pieceType, getMoves) => {
      let bb = pieces;
      while (bb) {
        const sqr = BBUtil.getLSBIndex(bb);
        const attackedZoneSquares = getMoves(sqr) & kingZone;
        if (attackedZoneSquares !== 0n) {
          units += BBUtil.countBits(attackedZoneSquares) * this.params.kingZoneAttackWeights[pieceType];
          attackingPieces++;
        }
        bb &= bb - 1n;
      }
    };

    addPressure(attackers.pawns, pawn, (sqr) => BBUtil.pawnAttacks(sqr, attackingClr));
    addPressure(attackers.knights, knight, (sqr) => BBUtil.knightMoves(sqr));
    addPressure(attackers.bishops, bishop, (sqr) => BBUtil.bishopMoves(sqr, occupied));
    addPressure(attackers.rooks, rook, (sqr) => BBUtil.rookMoves(sqr, occupied));
    addPressure(attackers.queens, queen, (sqr) => BBUtil.queenMoves(sqr, occupied));

    return { units, attackers: attackingPieces };
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
    //If the knight has no enemy pawns in front of it and has an ally pawn defending it
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
}
