//Keeps track of the position of all pieces and current game state
class Board {
  constructor() {
    this.init();
  }

  //Sets up an empty board
  init() {
    //0 == black, 1 == white
    this.clrToMove = white;

    /*Variables for current game state*/
    //Holds the current en-passant(able) file
    this.enPassantFile = undefined;
    //Used for 50-move draw rule. Increases after every move, if >100 it's a draw
    this.plyCounter = 0; //Gets reset on pawn moves & any capture
    this.lastCapturedPieceType = none;
    //Indexed by player color
    this.hasCastleRight = {
      kingSide: [false, false],
      queenSide: [false, false],
    };
    this.zobristKey = 0n;

    //Stack to keep track of game states for irreversible aspects of a position (en passant file, castling rights, etc) when undoing a move
    this.gameHistory = [];
    //Stack to keep track of the positions to detect 3 fold repetitions
    this.repetitionHistory = [];

    /*All piece bitboards*/
    this.white = {
      pieces: 0n,
      pawns: 0n,
      knights: 0n,
      bishops: 0n,
      rooks: 0n,
      queens: 0n,
      king: 0n,
    };

    this.black = {
      pieces: 0n,
      pawns: 0n,
      knights: 0n,
      bishops: 0n,
      rooks: 0n,
      queens: 0n,
      king: 0n,
    };

    this.piecesBB = 0n;
    this.piecesList = new Array(64).fill(0b0000);
    //Indexed by color (0 black, 1 white) and by piece type (0 all pieces, 1 pawn, 2 knight, etc)
    this.pieceCounts = Array.from({ length: 2 }, () => Array(7).fill(0));
  }

  getAllies(clr) {
    return clr == white ? this.white : this.black;
  }

  getEnemies(clr) {
    return clr == white ? this.black : this.white;
  }

  otherColor(clr) {
    return clr == white ? black : white;
  }

  makeMove(move, inSearch = false) {
    const startSquare = Move.startSqr(move);
    const targetSquare = Move.targetSqr(move);
    const flag = Move.flag(move);
    const isPromotion = Move.isPromotion(move);

    const movedPiece = this.piecesList[startSquare];
    const movedPieceType = Piece.type(movedPiece);
    const allyClr = Piece.clr(movedPiece);
    const enemyClr = allyClr == white ? black : white;

    const capturedPiece = flag == enPassantFlag ? Piece.newPiece(pawn, enemyClr) : this.piecesList[targetSquare];
    const capturedPieceType = Piece.type(capturedPiece);

    const allyPieces = allyClr == white ? this.white : this.black;
    const allyBBs = Object.entries(allyPieces);
    const enemyPieces = allyClr == white ? this.black : this.white;
    const enemyBBs = Object.entries(enemyPieces);

    const prevEnPassantFile = this.enPassantFile;
    const prevCastleRights = Zobrist.castleRightsToIndex(this);
    this.enPassantFile = undefined;

    //Updating moving color's bitboards (moving piece BB and all ally pieces BB)
    const movedPieceBB = allyBBs[movedPieceType][0];
    allyPieces[movedPieceBB] = BBUtil.toggleBits(startSquare, targetSquare, allyPieces[movedPieceBB]);
    allyPieces.pieces = BBUtil.toggleBits(startSquare, targetSquare, allyPieces.pieces);

    //Handle captures
    if (capturedPieceType != none) {
      let captureSquare = targetSquare;
      let capturedPieceBB = enemyBBs[capturedPieceType][0];
      //Handle en passant
      if (flag == enPassantFlag) {
        captureSquare = allyClr == white ? targetSquare + 8 : targetSquare - 8;
        capturedPieceBB = enemyBBs[pawn][0];
      }
      //Updating enemy color's bitboards, captured piece BB and all pieces
      enemyPieces[capturedPieceBB] = BBUtil.unsetBit(captureSquare, enemyPieces[capturedPieceBB]);
      //Updating the pieces array
      this.piecesList[captureSquare] = 0b0000;
      enemyPieces.pieces = BBUtil.unsetBit(captureSquare, enemyPieces.pieces);
      //Updating enemy piece counts
      this.pieceCounts[enemyClr][capturedPieceType]--;
      this.pieceCounts[enemyClr][0]--;

      this.zobristKey ^= Zobrist.pieces[captureSquare][capturedPiece];
    }

    //Updating board piece array (doesn't account for promotions as piece type changes in target square)
    this.piecesList[startSquare] = 0b0000;
    this.piecesList[targetSquare] = movedPiece;

    //Handle promotion
    if (isPromotion) {
      //Removing promoted pawn from ally pawns BB
      allyPieces.pawns = BBUtil.unsetBit(targetSquare, allyPieces.pawns);
      let promotionPieceType;
      switch (flag) {
        case promoteKnightFlag:
          promotionPieceType = knight;
          break;
        case promoteBishopFlag:
          promotionPieceType = bishop;
          break;
        case promoteRookFlag:
          promotionPieceType = rook;
          break;
        case promoteQueenFlag:
          promotionPieceType = queen;
          break;
      }
      const promotionPiece = Piece.newPiece(promotionPieceType, allyClr);
      //Adding promoted piece to the board list
      this.piecesList[targetSquare] = promotionPiece;
      //Adding promoted piece to ally's BB of its new type
      const promotionPieceBB = allyBBs[promotionPieceType][0];
      allyPieces[promotionPieceBB] = BBUtil.setBit(targetSquare, allyPieces[promotionPieceBB]);
      //Updating ally piece counts
      this.pieceCounts[allyClr][pawn]--;
      this.pieceCounts[allyClr][promotionPieceType]++;
    }

    //Handle castling (new king position is handled as any other regular move)
    if (movedPieceType == king) {
      //If the king ever moves, that color loses both castling privileges
      this.hasCastleRight.kingSide[allyClr] = false;
      this.hasCastleRight.queenSide[allyClr] = false;

      if (flag == castleFlag) {
        const isKingSide = targetSquare == 62 || targetSquare == 6; //g1 or g8
        //Find if the rook is to the left or right of the king
        const oldRookSquare = isKingSide ? startSquare + 3 : startSquare - 4; //h1 or a1
        //Its new position
        const newRookSquare = isKingSide ? startSquare + 1 : startSquare - 1; //f1 or d1
        //Updating the pieces array
        const movedRook = this.piecesList[oldRookSquare];
        this.piecesList[oldRookSquare] = 0b0000;
        this.piecesList[newRookSquare] = movedRook;
        //Moving rook position in rook & ally pieces bitboards
        allyPieces.rooks = BBUtil.toggleBits(oldRookSquare, newRookSquare, allyPieces.rooks);
        allyPieces.pieces = BBUtil.toggleBits(oldRookSquare, newRookSquare, allyPieces.pieces);

        this.zobristKey ^= Zobrist.pieces[oldRookSquare][movedRook];
        this.zobristKey ^= Zobrist.pieces[newRookSquare][movedRook];
      }
    }

    //Marking file as en passant file if a pawn double pushes
    if (flag == pawnTwoMoveFlag) {
      const enPassantFile = BoardUtil.squareToFile(startSquare);
      this.enPassantFile = enPassantFile;
      this.zobristKey ^= Zobrist.enPassant[enPassantFile];
    }

    //Updating castling rights (lost if any piece moves to/from initial rook squares)
    if (startSquare == 63 || targetSquare == 63) this.hasCastleRight.kingSide[white] = false; //h1
    if (startSquare == 7 || targetSquare == 7) this.hasCastleRight.kingSide[black] = false; //h8
    if (startSquare == 56 || targetSquare == 56) this.hasCastleRight.queenSide[white] = false; //a1
    if (startSquare == 0 || targetSquare == 0) this.hasCastleRight.queenSide[black] = false; //a8

    this.zobristKey ^= Zobrist.blackToMove;
    this.zobristKey ^= Zobrist.pieces[startSquare][movedPiece];
    this.zobristKey ^= Zobrist.pieces[targetSquare][this.piecesList[targetSquare]];
    if (prevEnPassantFile != undefined) this.zobristKey ^= Zobrist.enPassant[prevEnPassantFile];

    const newCastlingRights = Zobrist.castleRightsToIndex(this);
    if (prevCastleRights != newCastlingRights) {
      this.zobristKey ^= Zobrist.castlingRights[prevCastleRights];
      this.zobristKey ^= Zobrist.castlingRights[newCastlingRights];
    }

    this.plyCounter++;

    //Resetting ply counter if pawn move or capture
    if (movedPieceType == pawn || capturedPieceType != none) {
      if (!inSearch) this.repetitionHistory = [];
      this.plyCounter = 0;
    }

    //Pushing the newest game state (after move has been made) to the top of the history
    const newGameState = new GameState(this.enPassantFile, this.plyCounter, this.hasCastleRight, capturedPieceType, this.zobristKey);
    this.gameHistory.push(newGameState);
    this.lastCapturedPieceType = capturedPieceType;

    if (!inSearch) this.repetitionHistory.push(this.zobristKey);

    //Updating all pieces bitboard
    this.piecesBB = allyPieces.pieces | enemyPieces.pieces;

    //Swapping turn
    this.clrToMove = this.clrToMove == white ? black : white;
  }

  unmakeMove(move, inSearch = false) {
    const movedFrom = Move.startSqr(move);
    const movedTo = Move.targetSqr(move);
    const flag = Move.flag(move);
    const isPromotion = Move.isPromotion(move);

    this.gameHistory.pop(); //Ignoring the last/newest game state (the one from the move we are undoing)
    const prevGameState = this.gameHistory[this.gameHistory.length - 1]; //Taking the previous one

    //The ally color is the piece on the target square
    const allyClr = Piece.clr(this.piecesList[movedTo]);
    const enemyClr = allyClr == white ? black : white;

    const movedPiece = isPromotion ? Piece.newPiece(pawn, allyClr) : this.piecesList[movedTo];
    const movedPieceType = Piece.type(movedPiece);

    const capturedPieceType = this.lastCapturedPieceType;

    const allyPieces = allyClr == white ? this.white : this.black;
    const allyBBs = Object.entries(allyPieces);
    const enemyPieces = allyClr == white ? this.black : this.white;
    const enemyBBs = Object.entries(enemyPieces);

    //Undo promotion
    if (isPromotion) {
      //If the move was a promotion the piece on the target square is no longer a pawn
      const promotedPiece = this.piecesList[movedTo];
      const promotedPieceType = Piece.type(promotedPiece);

      this.piecesList[movedTo] = movedPiece; //So we set it to a pawn
      allyPieces.pawns = BBUtil.setBit(movedTo, allyPieces.pawns);
      const promotedPieceBB = allyBBs[promotedPieceType][0];
      //Unsetting the promoted piece square on its bitboard
      allyPieces[promotedPieceBB] = BBUtil.unsetBit(movedTo, allyPieces[promotedPieceBB]);
      //Updating ally piece counts
      this.pieceCounts[allyClr][pawn]++;
      this.pieceCounts[allyClr][promotedPieceType]--;
    }

    //Updating moving color's bitboards (moving piece BB and all ally pieces BB)
    const movedPieceBB = allyBBs[movedPieceType][0];
    allyPieces[movedPieceBB] = BBUtil.toggleBits(movedFrom, movedTo, allyPieces[movedPieceBB]);
    allyPieces.pieces = BBUtil.toggleBits(movedFrom, movedTo, allyPieces.pieces);
    //Updating board piece array
    this.piecesList[movedFrom] = movedPiece;
    this.piecesList[movedTo] = 0b0000; //Captures get handled later, if not a capture this is left empty

    //Undo captures
    if (capturedPieceType != none) {
      let captureSquare = movedTo;
      let capturedPieceBB = enemyBBs[capturedPieceType][0];
      //Handle en passant (only the capture square changes)
      if (flag == enPassantFlag) captureSquare = allyClr == white ? movedTo + 8 : movedTo - 8;
      //Updating enemy color's bitboards, captured piece BB and all pieces
      enemyPieces[capturedPieceBB] = BBUtil.setBit(captureSquare, enemyPieces[capturedPieceBB]);
      //Adding enemy piece back to the pieces array and enemy's bitboard
      this.piecesList[captureSquare] = Piece.newPiece(capturedPieceType, enemyClr);
      enemyPieces.pieces = BBUtil.setBit(captureSquare, enemyPieces.pieces);
      this.pieceCounts[enemyClr][0]++;
      this.pieceCounts[enemyClr][capturedPieceType]++;
    }

    //Undo castling (new king position is handled as any other regular move)
    if (movedPieceType == king) {
      if (flag == castleFlag) {
        const isKingSide = movedTo == 62 || movedTo == 6; //g1 or g8
        //Getting inital position of the rook (corners)
        const originalSquare = isKingSide ? movedFrom + 3 : movedFrom - 4; //h1 or a1
        //Getting its current position (after castling)
        const castledSquare = isKingSide ? movedFrom + 1 : movedFrom - 1; //f1 or d1
        //Updating the pieces array
        const movedRook = this.piecesList[castledSquare];
        this.piecesList[originalSquare] = movedRook;
        this.piecesList[castledSquare] = 0b0000;
        //Moving rook position in rook & ally pieces bitboards
        allyPieces.rooks = BBUtil.toggleBits(originalSquare, castledSquare, allyPieces.rooks);
        allyPieces.pieces = BBUtil.toggleBits(originalSquare, castledSquare, allyPieces.pieces);
      }
    }

    //Undo irreversible aspects of the position
    this.enPassantFile = prevGameState.enPassantFile;
    this.lastCapturedPieceType = prevGameState.capturedPieceType;

    //Updating castling rights (lost if any piece moves to/from initial rook squares)
    this.hasCastleRight.kingSide[white] = prevGameState.hasCastleRight.kingSide[white];
    this.hasCastleRight.kingSide[black] = prevGameState.hasCastleRight.kingSide[black];
    this.hasCastleRight.queenSide[white] = prevGameState.hasCastleRight.queenSide[white];
    this.hasCastleRight.queenSide[black] = prevGameState.hasCastleRight.queenSide[black];
    this.zobristKey = prevGameState.zobristKey;

    if (!inSearch) this.repetitionHistory.pop();

    this.plyCounter = prevGameState.plyCounter;

    //Updating all pieces bitboard
    this.piecesBB = allyPieces.pieces | enemyPieces.pieces;

    //Swapping turn
    this.clrToMove = this.clrToMove == white ? black : white;
  }

  makeNullMove(inSearch = false) {
    const prevEnPassantFile = this.enPassantFile;
    this.enPassantFile = undefined;

    this.zobristKey ^= Zobrist.blackToMove;
    if (prevEnPassantFile != undefined) this.zobristKey ^= Zobrist.enPassant[prevEnPassantFile];

    this.plyCounter++;

    const newGameState = new GameState(this.enPassantFile, this.plyCounter, this.hasCastleRight, none, this.zobristKey);
    this.gameHistory.push(newGameState);
    this.lastCapturedPieceType = none;

    if (!inSearch) this.repetitionHistory.push(this.zobristKey);

    // Swapping turn
    this.clrToMove = this.clrToMove == white ? black : white;
  }

  unmakeNullMove(inSearch = false) {
    this.gameHistory.pop();
    const prevGameState = this.gameHistory[this.gameHistory.length - 1];

    this.enPassantFile = prevGameState.enPassantFile;
    this.lastCapturedPieceType = prevGameState.capturedPieceType;

    this.hasCastleRight.kingSide[white] = prevGameState.hasCastleRight.kingSide[white];
    this.hasCastleRight.kingSide[black] = prevGameState.hasCastleRight.kingSide[black];
    this.hasCastleRight.queenSide[white] = prevGameState.hasCastleRight.queenSide[white];
    this.hasCastleRight.queenSide[black] = prevGameState.hasCastleRight.queenSide[black];
    this.zobristKey = prevGameState.zobristKey;

    if (!inSearch) this.repetitionHistory.pop();

    this.plyCounter = prevGameState.plyCounter;

    // Swapping turn back
    this.clrToMove = this.clrToMove == white ? black : white;
  }

  //Calculates whether the current position is a check without calculating all legal moves
  //If the king can see any attacker in any direction
  inCheck() {
    const kingSqr = this.clrToMove == white ? BBUtil.getLSBIndex(this.white.king) : BBUtil.getLSBIndex(this.black.king);
    const enemyPieces = this.clrToMove == white ? this.black : this.white;
    const blockersBB = this.piecesBB;

    const rookMoves = BBUtil.rookMoves(kingSqr, blockersBB);
    const enemyOrtho = enemyPieces.rooks | enemyPieces.queens;
    if ((enemyOrtho & rookMoves) != 0) return true;

    const bishopMoves = BBUtil.bishopMoves(kingSqr, blockersBB);
    const enemyDiag = enemyPieces.bishops | enemyPieces.queens;
    if ((enemyDiag & bishopMoves) != 0) return true;

    const knightMoves = BBUtil.knightMoves(kingSqr);
    if ((knightMoves & enemyPieces.knights) != 0) return true;

    const pawnMoves = BBUtil.pawnAttacks(kingSqr, this.clrToMove);
    if ((pawnMoves & enemyPieces.pawns) != 0) return true;

    return false;
  }

  // Returns a bitboard of ALL pieces (both colors) that attack a given square
  // given the current board occupancy. Sliding attacks use magic bitboards so
  // X-ray pieces are automatically revealed when a blocker is removed from occupancy.
  getAttackersTo(sqr, occupancy) {
    // Pawn attacks: look "backward" from the target using the opposite color's pattern
    const whitePawnAttackers = BBUtil.pawnAttacks(sqr, black) & this.white.pawns;
    const blackPawnAttackers = BBUtil.pawnAttacks(sqr, white) & this.black.pawns;
    const knightAttackers = BBUtil.knightMoves(sqr) & (this.white.knights | this.black.knights);
    // Diagonal sliders: bishops + queens
    const diagSliders = this.white.bishops | this.black.bishops | this.white.queens | this.black.queens;
    // Orthogonal sliders: rooks + queens
    const orthoSliders = this.white.rooks | this.black.rooks | this.white.queens | this.black.queens;
    const bishopAttackers = BBUtil.bishopMoves(sqr, occupancy) & diagSliders;
    const rookAttackers = BBUtil.rookMoves(sqr, occupancy) & orthoSliders;
    const kingAttackers = BBUtil.kingMoves(sqr) & (this.white.king | this.black.king);

    // Mask with occupancy so already-captured or already-moved pieces are never considered attackers
    return (whitePawnAttackers | blackPawnAttackers | knightAttackers | bishopAttackers | rookAttackers | kingAttackers) & occupancy;
  }

  //Returns the current material count for a given color with a given piece values array indexed by piece type
  getColorMaterial(clr, pieceValues) {
    let material = 0;
    for (let type of [pawn, bishop, knight, rook, queen]) {
      material += this.pieceCounts[clr][type] * pieceValues[type];
    }
    return material;
  }

  toString(sendBinary = false) {
    let board = "";
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const sqr = BoardUtil.indexToSquare(file, rank);
        board += Piece.toString(this.piecesList[sqr], sendBinary) + " ";
      }
      board += "\n";
    }
    return board;
  }

  //Fills board on load using given FEN notation
  fillBoard(FEN) {
    let file = 0;
    let rank = 0;

    //Splits FEN to 5 parts: Pieces, first turn, castling rights, en passant file, initial ply counter
    let parts = FEN.split(" ");

    //Loops over all pieces
    for (let c of parts[0]) {
      if (c == "/") {
        rank++;
        file = 0;
        continue;
      }
      if (c.charCodeAt() > 47 && c.charCodeAt() < 58) {
        file += parseInt(c, 10);
        continue;
      }

      //Upper case = white, lower case = black
      const clr = c == c.toUpperCase() ? white : black;
      const allyPieces = clr == white ? this.white : this.black;
      const sqr = BoardUtil.indexToSquare(file, rank);

      allyPieces.pieces = BBUtil.setBit(file, rank, allyPieces.pieces);
      switch (c.toUpperCase()) {
        case "P":
          allyPieces.pawns = BBUtil.setBit(file, rank, allyPieces.pawns);
          this.piecesList[sqr] = Piece.newPiece(pawn, clr);
          this.pieceCounts[clr][pawn]++;
          break;
        case "N":
          allyPieces.knights = BBUtil.setBit(file, rank, allyPieces.knights);
          this.piecesList[sqr] = Piece.newPiece(knight, clr);
          this.pieceCounts[clr][knight]++;
          break;
        case "B":
          allyPieces.bishops = BBUtil.setBit(file, rank, allyPieces.bishops);
          this.piecesList[sqr] = Piece.newPiece(bishop, clr);
          this.pieceCounts[clr][bishop]++;
          break;
        case "R":
          allyPieces.rooks = BBUtil.setBit(file, rank, allyPieces.rooks);
          this.piecesList[sqr] = Piece.newPiece(rook, clr);
          this.pieceCounts[clr][rook]++;
          break;
        case "Q":
          allyPieces.queens = BBUtil.setBit(file, rank, allyPieces.queens);
          this.piecesList[sqr] = Piece.newPiece(queen, clr);
          this.pieceCounts[clr][queen]++;
          break;
        case "K":
          allyPieces.king = BBUtil.setBit(file, rank, allyPieces.king);
          this.piecesList[sqr] = Piece.newPiece(king, clr);
          this.pieceCounts[clr][king]++;
          break;
      }
      this.pieceCounts[clr][0]++;
      file++;
    }

    this.piecesBB = this.white.pieces | this.black.pieces; //Combines white & black bitboards
    this.clrToMove = parts[1] == "w" ? white : black; //Sets first move turn

    //Loops over section containing initial castling rights
    if (parts[2] != undefined)
      for (let c of parts[2]) {
        switch (c) {
          case "K":
            this.hasCastleRight.kingSide[white] = true;
            break;
          case "Q":
            this.hasCastleRight.queenSide[white] = true;
            break;
          case "k":
            this.hasCastleRight.kingSide[black] = true;
            break;
          case "q":
            this.hasCastleRight.queenSide[black] = true;
            break;
        }
      }

    //If given, sets the current enPassant file for the initial position
    if (parts[3] != undefined && parts[3].length == 2) this.enPassantFile = BoardUtil.nameToFile(parts[3]);

    this.plyCounter = parseInt(parts[4], 10);

    //Getting the first zobrist key (the rest are computed incrementally when making/unmaking moves)
    this.zobristKey = Zobrist.computeZobristHash(this);

    //Pushing the initial state of the board to the game history
    const firstGameState = new GameState(this.enPassantFile, this.plyCounter, this.hasCastleRight, none, this.zobristKey);
    this.gameHistory.push(firstGameState);
    this.repetitionHistory.push(this.zobristKey);
  }

  //Transforms the current board position to FEN notation
  //NOTE: For simplicity, this always includes the "enpassant-able" square even if it isn't a legal move
  toFEN(includeEnPassant = false, includePlyCounter = false) {
    let FEN = "";
    //Part 1: Pieces
    for (let rank = 0; rank < 8; rank++) {
      //FEN notation starts from rank 8 (top rank). In this engine rank 8 is 0
      let emptyFiles = 0;
      for (let file = 0; file < 8; file++) {
        const sqr = BoardUtil.indexToSquare(file, rank);
        const piece = this.piecesList[sqr];
        const pieceType = Piece.type(piece);
        const pieceClr = Piece.clr(piece);
        if (pieceType == none) {
          emptyFiles++;
          continue;
        }

        if (emptyFiles != 0) {
          FEN += emptyFiles;
          emptyFiles = 0;
        }

        let pieceSymbol = "";
        switch (pieceType) {
          case pawn:
            pieceSymbol = "p";
            break;
          case knight:
            pieceSymbol = "n";
            break;
          case bishop:
            pieceSymbol = "b";
            break;
          case rook:
            pieceSymbol = "r";
            break;
          case queen:
            pieceSymbol = "q";
            break;
          case king:
            pieceSymbol = "k";
            break;
        }

        pieceSymbol = pieceClr == white ? pieceSymbol.toUpperCase() : pieceSymbol;
        FEN += pieceSymbol;
      }

      if (emptyFiles != 0) FEN += emptyFiles;
      if (rank != 7) FEN += "/";
    }

    //Part 2: Color to move
    FEN += this.clrToMove == white ? " w" : " b";

    //Part 3: Castling rights
    FEN += " ";
    if (this.hasCastleRight.kingSide[white]) FEN += "K";
    if (this.hasCastleRight.queenSide[white]) FEN += "Q";
    if (this.hasCastleRight.kingSide[black]) FEN += "k";
    if (this.hasCastleRight.queenSide[black]) FEN += "q";
    if (Zobrist.castleRightsToIndex(this) == 0) FEN += "-";

    //Part 4: Enpassant file
    if (includeEnPassant) {
      FEN += " ";
      const epFile = this.enPassantFile;
      const epRank = this.clrToMove == white ? 2 : 5;
      FEN += epFile == undefined ? "-" : BoardUtil.indexToName(epFile, epRank);
    }

    //Part 5: Ply counter (can't be included if en passant wasn't)
    if (includeEnPassant && includePlyCounter) {
      FEN += " ";
      FEN += this.plyCounter;

      //Also include the move history size at the end
      FEN += " ";
      FEN += this.gameHistory.length;
    }

    return FEN;
  }
}
