//Interface between player and chess board
//Keeps track of move history to undo and calculates game result after every move
class Engine {
  constructor(FEN) {
    this.board = new Board();
    this.board.fillBoard(FEN);
    this.moveGenerator = new MoveGenerator();
    this.moves = []; //List of legal moves for the current position

    this.moveHistory = []; //Stack for all moves played
    this.redoHistory = []; //Stack for redoing moves after undoing them
    this.moveSANHistory = []; //SAN notation for moves in moveHistory
    this.redoSANHistory = []; //SAN notation for moves in redoHistory

    this.clrToMove = this.board.clrToMove;
    this.result = GameResult.starting;
    this.gameIsOver = false;
    this.positionGeneration = 0;
    this.listeners = new Set();

    //Keeps the amount of pieces that have been captured for either color indexed by piece (see Piece.js for explanation)
    this.capturedPieceCounts = new Array(15).fill(0);
    //Initial material value for both colors
    this.whiteMaterial = this.board.getColorMaterial(white, standardPieceValues);
    this.blackMaterial = this.board.getColorMaterial(black, standardPieceValues);

    // Snapshot of the original game once it concludes
    this.originalGameConcluded = false;
    this.originalResult = null;
    this.originalMoves = [];
    this.originalSANMoves = [];

    // Analysis branch tracking
    this.isAnalyzing = false;
    this.analysisBranchPly = 0;
    this.analysisMoves = [];
    this.analysisSANHistory = [];
    this.analysisRedoMoves = [];
    this.analysisRedoSANHistory = [];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, detail = {}) {
    for (const listener of this.listeners) listener({ type, ...detail, engine: this });
  }

  markPositionChanged() {
    this.positionGeneration++;
    this.emit("positionChanged");
  }

  snapshotOriginalGame() {
    if (this.originalGameConcluded) return;
    this.originalGameConcluded = true;
    this.originalResult = this.result;
    this.originalMoves = [...this.moveHistory, ...this.redoHistory.slice().reverse()];
    this.originalSANMoves = [...this.moveSANHistory, ...this.redoSANHistory.slice().reverse()];
  }

  // Called by an external clock/controller when the active side flags.
  handleTimeOut(color = this.clrToMove) {
    if (this.result !== GameResult.inProgress || color !== this.clrToMove) return false;
    this.gameIsOver = true;
    this.result = color === white ? GameResult.whiteTimeOut : GameResult.blackTimeOut;
    this.snapshotOriginalGame();
    this.emit("gameStateChanged", { reason: "timeout" });
    return true;
  }

  // Ends the game externally (e.g. loading a completed PGN or resigning)
  endGame(result = "Game Over") {
    this.gameIsOver = true;
    if (this.result === GameResult.inProgress || this.result === GameResult.starting) {
      this.result = result;
    }
    this.snapshotOriginalGame();
    this.emit("gameStateChanged");
  }

  startGame() {
    if (this.result != GameResult.starting) return;
    this.result = GameResult.inProgress;
    this.runGame();
  }

  runGame() {
    this.clrToMove = this.board.clrToMove;
    this.moves = this.moveGenerator.generateMoves(this.board);
    const plyCounter = this.board.plyCounter;

    // A position may be revisited through undo/redo. Re-evaluate its result
    // from scratch instead of retaining the terminal result of a later move.
    if (this.result !== GameResult.starting) {
      this.result = GameResult.inProgress;
      this.gameIsOver = false;
    }

    this.whiteMaterial = this.board.getColorMaterial(white, standardPieceValues);
    this.blackMaterial = this.board.getColorMaterial(black, standardPieceValues);

    //Checking game result after every move
    if (this.moves.length == 0) {
      const inCheck = this.moveGenerator.inCheck;
      this.result = inCheck ? this.getCheckmateResult() : GameResult.stalemate;
    }

    if (plyCounter >= 100) this.result = GameResult.fiftyMoveRule;
    if (this.isThreefoldRepetition()) this.result = GameResult.drawByRepetition;
    if (this.isInsufficientMaterial()) this.result = GameResult.insufficientMaterial;

    if (this.result != GameResult.inProgress) {
      this.gameIsOver = true;
      if (!this.originalGameConcluded && !this.isAnalyzing) {
        this.snapshotOriginalGame();
      }
    } else if (this.originalGameConcluded && !this.isAnalyzing && this.moveHistory.length === this.originalMoves.length) {
      // Reached the terminal position of the original concluded game
      this.result = this.originalResult;
      this.gameIsOver = true;
    }

    this.emit("gameStateChanged");
  }

  //For both players & bots, final moves must be made through this function for the game to update correctly
  //Moves can be played directly on the board.makeMove for evaluation though
  playMove(move, redoingMove = false, deferUpdate = false) {
    const sanMove = Move.UCIToSAN(Move.toString(move), this.board) || Move.toString(move);
    const isCapture = Piece.type(Move.capturePiece(move, this.board)) !== none || Move.flag(move) === enPassantFlag;
    const isCastle = Move.flag(move) === castleFlag;

    if (this.originalGameConcluded) {
      if (this.isAnalyzing) {
        if (redoingMove) {
          const san = this.analysisRedoSANHistory.pop() || sanMove;
          this.analysisMoves.push(move);
          this.analysisSANHistory.push(san);
          this.moveHistory.push(move);
          this.moveSANHistory.push(san);
        } else {
          // Playing a new analysis move while already in analysis
          this.analysisMoves.push(move);
          this.analysisSANHistory.push(sanMove);
          this.analysisRedoMoves = [];
          this.analysisRedoSANHistory = [];
          this.moveHistory.push(move);
          this.moveSANHistory.push(sanMove);
        }
      } else {
        if (redoingMove) {
          // Redoing an original game move
          const san = this.redoSANHistory.pop() || sanMove;
          this.moveHistory.push(move);
          this.moveSANHistory.push(san);
        } else {
          // Starting a new analysis line from the current position
          this.isAnalyzing = true;
          this.analysisBranchPly = this.moveHistory.length;
          this.analysisMoves = [move];
          this.analysisSANHistory = [sanMove];
          this.analysisRedoMoves = [];
          this.analysisRedoSANHistory = [];
          this.moveHistory.push(move);
          this.moveSANHistory.push(sanMove);
        }
      }
    } else {
      this.moveHistory.push(move);
      this.moveSANHistory.push(redoingMove ? this.redoSANHistory.pop() || sanMove : sanMove);
      if (!redoingMove) {
        this.redoHistory = [];
        this.redoSANHistory = [];
      }
    }

    this.updateCapturedArrays(move, false);
    this.board.makeMove(move);

    if (!deferUpdate) {
      this.markPositionChanged();
      this.runGame();
      this.emit("movePlayed", { move, isCapture, isCastle, redoingMove, isAnalysis: this.isAnalyzing });
    }
  }

  //Undoes the last played move, to undo any move without updating results use board.unmakeMove instead
  undoMove(deferUpdate = false) {
    if (this.moveHistory.length == 0) return;
    if (!deferUpdate) this.emit("historyNavigationStarted");

    let moveToUndo;

    if (this.isAnalyzing) {
      moveToUndo = this.analysisMoves.pop();
      const sanToUndo = this.analysisSANHistory.pop() || Move.toString(moveToUndo);
      this.analysisRedoMoves.push(moveToUndo);
      this.analysisRedoSANHistory.push(sanToUndo);

      this.moveHistory.pop();
      this.moveSANHistory.pop();

      this.board.unmakeMove(moveToUndo);
      this.updateCapturedArrays(moveToUndo, true);

      // When all analysis moves are undone, resume normal original game redo
      if (this.analysisMoves.length === 0) {
        this.isAnalyzing = false;
        this.analysisRedoMoves = [];
        this.analysisRedoSANHistory = [];
        this.redoHistory = this.originalMoves.slice(this.analysisBranchPly).reverse();
        this.redoSANHistory = this.originalSANMoves.slice(this.analysisBranchPly).reverse();
      }
    } else {
      moveToUndo = this.moveHistory.pop();
      this.redoHistory.push(moveToUndo);
      this.redoSANHistory.push(this.moveSANHistory.pop() || Move.toString(moveToUndo));

      this.board.unmakeMove(moveToUndo);
      this.updateCapturedArrays(moveToUndo, true);
    }

    if (!deferUpdate) {
      this.markPositionChanged();
      this.runGame();
      this.emit("moveUndone", { move: moveToUndo, isAnalysis: this.isAnalyzing });
    }
  }

  //Updates captured pieces arrays after every played move
  updateCapturedArrays(move, undoingMove = false) {
    const capturedPiece = Move.capturePiece(move, this.board);
    const capturedPieceType = Piece.type(capturedPiece);
    if (capturedPieceType == none) return;

    const multiplier = undoingMove == false ? 1 : -1;
    const capturedPieceClr = Piece.clr(capturedPiece);
    this.capturedPieceCounts[Piece.newPiece(capturedPieceType, capturedPieceClr)] += 1 * multiplier;
  }

  //Redoes the last undone move
  redoMove(deferUpdate = false) {
    if (this.isAnalyzing) {
      if (this.analysisRedoMoves.length == 0) return;
      if (!deferUpdate) this.emit("historyNavigationStarted");
      const moveToRedo = this.analysisRedoMoves.pop();
      this.playMove(moveToRedo, true, deferUpdate);
    } else {
      if (this.redoHistory.length == 0) return;
      if (!deferUpdate) this.emit("historyNavigationStarted");
      const moveToRedo = this.redoHistory.pop();
      this.playMove(moveToRedo, true, deferUpdate);
    }
  }

  // Goes to the position immediately after targetMoveCount plies.  Batched
  // navigation updates the UI once and stays silent when it changes multiple plies.
  goToMove(targetMoveCount) {
    const totalMoveCount = this.isAnalyzing
      ? this.moveHistory.length + this.analysisRedoMoves.length
      : this.moveHistory.length + this.redoHistory.length;
    const target = Math.max(0, Math.min(targetMoveCount, totalMoveCount));
    const movesToTravel = target - this.moveHistory.length;
    if (movesToTravel === 0) return;
    this.emit("historyNavigationStarted");
    const soundMove =
      Math.abs(movesToTravel) === 1
        ? movesToTravel > 0
          ? this.isAnalyzing
            ? this.analysisRedoMoves[this.analysisRedoMoves.length - 1]
            : this.redoHistory[this.redoHistory.length - 1]
          : this.moveHistory[this.moveHistory.length - 1]
        : undefined;
    // A forward move has not been applied yet, so its capture can be read now.
    const soundIsCapture =
      soundMove && movesToTravel > 0
        ? Piece.type(Move.capturePiece(soundMove, this.board)) !== none || Move.flag(soundMove) === enPassantFlag
        : undefined;

    while (this.moveHistory.length > target) this.undoMove(true);
    while (this.moveHistory.length < target) this.redoMove(true);

    this.markPositionChanged();
    this.runGame();
    this.emit("navigation", { moveCount: target, soundMove, soundIsCapture });
  }

  goToFirstPosition() {
    this.goToMove(0);
  }

  goToLastPosition() {
    const totalMoveCount = this.isAnalyzing
      ? this.moveHistory.length + this.analysisRedoMoves.length
      : this.moveHistory.length + this.redoHistory.length;
    this.goToMove(totalMoveCount);
  }

  isUndoingMoves() {
    if (this.isAnalyzing) {
      return this.analysisRedoMoves.length !== 0;
    }
    return this.redoHistory.length != 0;
  }

  getCheckmateResult() {
    return this.clrToMove == white ? GameResult.blackCheckmated : GameResult.whiteCheckmated;
  }

  getTimeOutResult() {
    return this.clrToMove == white ? GameResult.whiteTimeOut : GameResult.blackTimeOut;
  }

  isThreefoldRepetition() {
    const currentKey = this.board.zobristKey;
    let count = 0;
    for (let hash of this.board.repetitionHistory) {
      if (hash == currentKey) count++;
      if (count >= 3) return true;
    }
    return false;
  }

  //TODO: Check if this covers all draw cases
  isInsufficientMaterial() {
    const pieceCounts = this.board.pieceCounts;
    const whitePieceCount = pieceCounts[white][0];
    const blackPieceCount = pieceCounts[black][0];
    const allPieceCount = whitePieceCount + blackPieceCount;
    const pawnsCount = pieceCounts[white][pawn] + pieceCounts[black][pawn];
    const knightsCount = pieceCounts[white][knight] + pieceCounts[black][knight];
    const whiteBishopsCount = pieceCounts[white][bishop];
    const blackBishopsCount = pieceCounts[black][bishop];
    const bishopsCount = pieceCounts[white][bishop] + pieceCounts[black][bishop];
    const rooksCount = pieceCounts[white][rook] + pieceCounts[black][rook];
    const queensCount = pieceCounts[white][queen] + pieceCounts[black][queen];

    //Pawns prevent draw by insufficient material
    if (pawnsCount > 0) return false;

    //Rooks and queens prevent draws too
    if (rooksCount > 0 || queensCount > 0) return false;

    //King vs king = draw
    //Since the king can never be captured, if both colors only have 1 piece (kings) it's a draw
    if (whitePieceCount == 1 && blackPieceCount == 1) return true;

    //King + bishop vs king = draw
    //2 kings + 1 bishop of any color
    if (allPieceCount == 3 && bishopsCount == 1) return true;

    //King + knight vs king = draw
    //2 kings + 1 knight of any color
    if (allPieceCount == 3 && knightsCount == 1) return true;

    //King + bishop vs king + bishop = draw (when they are the same color only)
    //2 kings + 2 bishops
    if (allPieceCount == 4 && whiteBishopsCount == 1 && blackBishopsCount == 1) {
      //Get both bishop squares
      const whiteBishopSqr = BBUtil.getLSBIndex(this.board.white.bishops);
      const blackBishopSqr = BBUtil.getLSBIndex(this.board.black.bishops);
      //If they are on the same square color return true, otherwise false
      return BoardUtil.isLightSquare(whiteBishopSqr) == BoardUtil.isLightSquare(blackBishopSqr);
    }

    return false;
  }

  restartGame() {
    this.board.init();
    this.board.fillBoard(startFEN);
    this.clrToMove = this.board.clrToMove;
    this.gameIsOver = false;

    this.moveHistory = [];
    this.redoHistory = [];
    this.moveSANHistory = [];
    this.redoSANHistory = [];

    this.originalGameConcluded = false;
    this.originalResult = null;
    this.originalMoves = [];
    this.originalSANMoves = [];

    this.isAnalyzing = false;
    this.analysisBranchPly = 0;
    this.analysisMoves = [];
    this.analysisSANHistory = [];
    this.analysisRedoMoves = [];
    this.analysisRedoSANHistory = [];

    this.capturedPieceCounts = new Array(15).fill(0);
    this.whiteMaterial = this.board.getColorMaterial(white, standardPieceValues);
    this.blackMaterial = this.board.getColorMaterial(black, standardPieceValues);

    this.result = GameResult.starting;
    this.moveGenerator = new MoveGenerator();
    this.markPositionChanged();
    this.emit("restarted");
  }

  loadFEN(fen) {
    this.board.init();
    this.board.fillBoard(fen.trim());
    this.clrToMove = this.board.clrToMove;
    this.moveHistory = [];
    this.redoHistory = [];
    this.moveSANHistory = [];
    this.redoSANHistory = [];

    this.originalGameConcluded = false;
    this.originalResult = null;
    this.originalMoves = [];
    this.originalSANMoves = [];

    this.isAnalyzing = false;
    this.analysisBranchPly = 0;
    this.analysisMoves = [];
    this.analysisSANHistory = [];
    this.analysisRedoMoves = [];
    this.analysisRedoSANHistory = [];

    this.capturedPieceCounts = new Array(15).fill(0);
    this.whiteMaterial = this.board.getColorMaterial(white, standardPieceValues);
    this.blackMaterial = this.board.getColorMaterial(black, standardPieceValues);
    this.moveGenerator = new MoveGenerator();
    this.moves = [];
    this.result = GameResult.starting;
    this.gameIsOver = false;
    this.markPositionChanged();
    this.emit("positionLoaded");
  }

  //Validates a given FEN String
  isValidFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    //piece placement, color to move, castling rights, en passant file (or ""-"" if none)
    if (parts.length < 1) return "Missing piece placement";
    if (parts.length < 2) return "Missing color to move";
    if (parts.length < 3) return "Missing castling rights (- if none)";
    if (parts.length < 4) return "Missing En passant file (- if none)";

    const [placement, activeColor, castling, enPassant, halfmove, fullmove] = parts;

    const rows = placement.split("/");
    if (rows.length != 8) return "Found: " + rows.length + " rows (expected 8)"; //Need 8 rows

    //Each row must sum to 8 squares
    for (const row of rows) {
      let count = 0;
      for (const c of row) {
        if (/[1-8]/.test(c)) count += parseInt(c, 10);
        else if (/[prnbqkPRNBQK]/.test(c)) count += 1;
        else return "Invalid character found: " + c; //Invalid character
      }
      if (count != 8) return "Found: " + count + " columns (expected 8)";
    }

    //Check color to move
    if (!/^[wb]$/.test(activeColor)) return "Invalid color to move";

    //Check castling rights
    if (!/^(K?Q?k?q?|-)$/i.test(castling)) return "Invalid castling rights";

    //Check en passant (either "-" or valid square)
    if (!/^(-|[a-h][36])$/.test(enPassant)) return "Invalid En passant file";

    return "Valid FEN";
  }
}

const GameResult = Object.freeze({
  starting: "Starting game...",
  inProgress: "In Progress",
  whiteCheckmated: "White Checkmated",
  blackCheckmated: "Black Checkmated",
  whiteTimeOut: "White ran out of time",
  blackTimeOut: "Black ran out of time",
  insufficientMaterial: "Draw due to insufficient material",
  fiftyMoveRule: "Draw due to fifty move rule",
  stalemate: "Stalemate",
  drawByRepetition: "Draw by 3 fold repetition",
});
