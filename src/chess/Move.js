/*
Represented as 16 bits (FFFF TTTTTT SSSSSS):
  First 4 = Special move flags F (promotions, castling, etc)
  Second 6 = Target square T (0-63)
  Third 6 = Start square S (0-63)
*/
//Note: a8-a8 = invalid move

class Move {
  static newMove(startSqr, targetSqr, flag = 0b0000) {
    return startSqr | (targetSqr << 6) | (flag << 12);
  }

  static startSqr(move) {
    return move & this.startSqrMask;
  }

  static targetSqr(move) {
    return (move & this.targetSqrMask) >> 6;
  }

  static flag(move) {
    return (move & this.flagMask) >> 12;
  }

  //Returns what the captured piece would be if the move were played
  //Note: the move must not have been played already
  static capturePiece(move, board) {
    const enemyClr = board.clrToMove == white ? black : white;
    if (this.flag(move) == enPassantFlag) return Piece.newPiece(pawn, enemyClr);
    const capturedPiece = board.piecesList[this.targetSqr(move)];
    return Piece.newPiece(capturedPiece, enemyClr);
  }

  //Returns what the captured piece type would be if the move were played
  //Note: the move must not have been played already
  static capturePieceType(move, board) {
    if (this.flag(move) == enPassantFlag) return pawn;
    const capturedPiece = board.piecesList[this.targetSqr(move)];
    return Piece.type(capturedPiece);
  }

  //Returns if the move is a capture
  //Note: the move must not have been played already
  static isCapture(move, board) {
    return this.capturePieceType(move, board) != none;
  }

  //Prints move in 16-bit binary format OR in square (UCI) notation (ex: e2e4)
  static toString(move, sendBinary = false) {
    if (sendBinary) return move.toString(2).padStart(16, "0");

    const startSqr = this.startSqr(move);
    const targetSqr = this.targetSqr(move);
    let moveString = BoardUtil.sqrToString(startSqr) + BoardUtil.sqrToString(targetSqr);
    const flag = this.flag(move);

    switch (flag) {
      case promoteKnightFlag:
        moveString += "n";
        break;
      case promoteBishopFlag:
        moveString += "b";
        break;
      case promoteRookFlag:
        moveString += "r";
        break;
      case promoteQueenFlag:
        moveString += "q";
        break;
    }

    return moveString;
  }

  static isPromotion(move) {
    const moveFlag = this.flag(move);
    return moveFlag == promoteKnightFlag || moveFlag == promoteBishopFlag || moveFlag == promoteRookFlag || moveFlag == promoteQueenFlag;
  }

  //Gets a move in UCI format and transforms it to 16 bits for internal representation (ex e4 = e2e4 -> 0b11100100110100)
  //The board before the move is played is needed to identify its flag correctly
  static UCIToMove(uci, board) {
    //First two characters are the starting square
    const startSquareName = uci.charAt(0) + uci.charAt(1);
    //Second two characters are the target square
    const targetSquareName = uci.charAt(2) + uci.charAt(3);

    const startSquare = BoardUtil.nameToSquare(startSquareName);
    const startFile = BoardUtil.squareToFile(startSquare);
    const startRank = BoardUtil.squareToRank(startSquare);

    const targetSquare = BoardUtil.nameToSquare(targetSquareName);
    const targetFile = BoardUtil.squareToFile(targetSquare);
    const targetRank = BoardUtil.squareToRank(targetSquare);

    const movedPieceType = Piece.type(board.piecesList[startSquare]);

    let moveFlag = noFlag;

    if (movedPieceType == pawn) {
      if (uci.length == 5) {
        //If there is a fifth character it represents a promotion type
        switch (uci.charAt(4)) {
          case "n":
            moveFlag = promoteKnightFlag;
            break;
          case "b":
            moveFlag = promoteBishopFlag;
            break;
          case "r":
            moveFlag = promoteRookFlag;
            break;
          case "q":
            moveFlag = promoteQueenFlag;
            break;
        }
      } else if (Math.abs(targetRank - startRank) == 2) {
        //If the pawn is moving 2 ranks it is a double push
        moveFlag = pawnTwoMoveFlag;
      } else if (startFile != targetFile && Piece.type(board.piecesList[targetSquare]) == none) {
        //If the pawn is changing files but there is no piece in its target square it's en passant
        moveFlag = enPassantFlag;
      }
    }

    //If the king is moving 2 squares it must be castling
    if (movedPieceType == king && Math.abs(targetFile - startFile) == 2) {
      moveFlag = castleFlag;
    }
    return this.newMove(startSquare, targetSquare, moveFlag);
  }

  //Given a UCI formatted move, return the SAN (Standard algebraic notation) format (ex: g1f3 could be equal to Nf3)
  static UCIToSAN(uci, board) {
    const from = BoardUtil.nameToSquare(uci.slice(0, 2));
    const to = BoardUtil.nameToSquare(uci.slice(2, 4));
    const promotion = uci.length === 5 ? uci[4] : null;

    const movingPiece = board.piecesList[from];
    const pieceType = Piece.type(movingPiece);
    const moveGen = new MoveGenerator();

    //Handle castling
    if (pieceType === king && Math.abs(BoardUtil.squareToFile(to) - BoardUtil.squareToFile(from)) === 2) {
      return BoardUtil.squareToFile(to) > BoardUtil.squareToFile(from) ? "O-O" : "O-O-O";
    }

    //Determine base letter (omit for pawns)
    const pieceLetter = ["", "", "N", "B", "R", "Q", "K"][pieceType];

    //Detect if it's a capture
    const isCapture = this.isCapture(this.UCIToMove(uci, board), board);

    let disambiguation = "";
    //Determine disambiguation if needed (same piece type can move to the same square)
    if (pieceType !== pawn && pieceType !== king) {
      const moves = moveGen.generateMoves(board);
      const samePieceMoves = moves.filter((mv) => {
        return Move.targetSqr(mv) === to && Move.startSqr(mv) !== from && Piece.type(board.piecesList[Move.startSqr(mv)]) === pieceType;
      });
      if (samePieceMoves.length > 0) {
        const fromFile = BoardUtil.squareToFile(from);
        const fromRank = BoardUtil.squareToRank(from);
        const fileConflict = samePieceMoves.some((mv) => BoardUtil.squareToFile(Move.startSqr(mv)) === fromFile);
        const rankConflict = samePieceMoves.some((mv) => BoardUtil.squareToRank(Move.startSqr(mv)) === fromRank);

        if (!fileConflict) disambiguation = BoardUtil.fileToChar(fromFile);
        else if (!rankConflict) disambiguation = (8 - fromRank).toString();
        else disambiguation = BoardUtil.fileToChar(fromFile) + (8 - fromRank);
      }
    }

    //Pawn move captures must include the origin file (e.g. exd5)
    let san = "";
    if (pieceType === pawn) {
      if (isCapture) san += BoardUtil.fileToChar(BoardUtil.squareToFile(from));
    } else {
      san += pieceLetter + disambiguation;
    }

    if (isCapture) san += "x";

    san += BoardUtil.indexToName(to);

    if (promotion) {
      san += "=" + promotion.toUpperCase();
    }

    const moveToMake = Move.UCIToMove(uci, board);
    //Make the move temporarily to check for check or checkmate
    board.makeMove(moveToMake);
    const legalMoves = moveGen.generateMoves(board);
    const inCheck = moveGen.inCheck;
    const isMate = inCheck && legalMoves.length === 0;
    board.unmakeMove(moveToMake);

    if (isMate) san += "#";
    else if (inCheck) san += "+";

    return san;
  }

  static SANToUCI(san, board) {
    const moveGen = new MoveGenerator();
    const legalMoves = moveGen.generateMoves(board);

    //Remove check/mate symbols
    san = san.replace(/[+#]/g, "");

    //Handle castling
    if (san === "O-O") {
      return board.clrToMove === white ? "e1g1" : "e8g8";
    }
    if (san === "O-O-O") {
      return board.clrToMove === white ? "e1c1" : "e8c8";
    }

    //Parse SAN components
    let pieceLetter = "";
    let promotion = null;

    //Promotion
    if (san.includes("=")) {
      const parts = san.split("=");
      san = parts[0];
      promotion = parts[1].toLowerCase(); //q,r,b,n
    }

    //Piece letter
    if (/^[NBRQK]/.test(san)) {
      pieceLetter = san[0];
      san = san.slice(1);
    }

    //Remaining san contains something like:
    // e4
    // exd5
    // fxe5
    // 1e3 or Ne3

    //Extract disambiguation characters
    //Could be file, rank, or both
    let disFile = null;
    let disRank = null;

    if (san.length > 2) {
      const prefix = san.slice(0, san.length - 2);
      for (let ch of prefix) {
        if (/[a-h]/.test(ch)) disFile = BoardUtil.charToFile(ch);
        if (/[1-8]/.test(ch)) disRank = 8 - parseInt(ch);
      }
    }

    const targetName = san.slice(-2); // final square name (ex: e4)
    const to = BoardUtil.nameToSquare(targetName);

    //Determine piece type
    const typeMap = { "": pawn, N: knight, B: bishop, R: rook, Q: queen, K: king };
    const targetPieceType = typeMap[pieceLetter];

    //Find the matching legal move
    for (let mv of legalMoves) {
      const from = Move.startSqr(mv);
      const toSq = Move.targetSqr(mv);

      if (toSq !== to) continue;

      const piece = board.piecesList[from];
      if (!piece) continue;

      if (Piece.type(piece) !== targetPieceType) continue;

      //Check disambiguation
      const file = BoardUtil.squareToFile(from);
      const rank = BoardUtil.squareToRank(from);

      if (disFile !== null && disFile !== file) continue;
      if (disRank !== null && disRank !== rank) continue;

      //Promo check
      if (promotion) {
        let mvPromo;
        switch (this.flag(mv)) {
          case promoteKnightFlag:
            mvPromo = "n";
            break;
          case promoteBishopFlag:
            mvPromo = "b";
            break;
          case promoteRookFlag:
            mvPromo = "r";
            break;
          case promoteQueenFlag:
            mvPromo = "q";
            break;
        }
        if (mvPromo !== promotion) continue;
      }

      //This is the matching SAN
      return this.toString(mv);
    }

    console.error("SANToUCI failed to match move: " + san);
    return null;
  }
}

Move.startSqrMask = 0b0000000000111111;
Move.targetSqrMask = 0b0000111111000000;
Move.flagMask = 0b1111000000000000;