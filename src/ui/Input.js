/*All user input methods*/
let selectedSquare;
let selectedPremoveColor;
let selectToggle = true;
let dragging = false;

function touchStarted() {
  if (!chess) return;
  if (chess.result == GameResult.starting) return;

  const { currentFile, currentRank, currentSquare } = getCurrentMouseCoords(this.mouseX, this.mouseY);
  if (mouseButton === RIGHT) {
    // Right-click cancels an active premove queue. Board annotations remain
    // available when there is no queue to cancel.
    if (gameUI?.premoves?.hasItems()) {
      gameUI.premoves.clear();
      selectedSquare = undefined;
      selectedPremoveColor = undefined;
      return false;
    }
    beginBoardAnnotation(this.mouseX, this.mouseY);
    return false;
  }

  // A normal board click starts a new annotation set before it is processed
  // as a piece selection or move.
  if (!BoardUtil.outOfBounds(currentFile, currentRank)) clearBoardAnnotations();
  if (promotionMenu.active) {
    const playedMove = handlePromotionClick(currentFile, currentRank);
    if (playedMove != undefined) registerPlayerMove(playedMove);
    return;
  }

  if (BoardUtil.outOfBounds(currentFile, currentRank)) {
    selectedSquare = undefined;
    selectedPremoveColor = undefined;
    return;
  }

  if (selectedSquare != undefined) {
    const playedMove = searchMoves(selectedSquare, currentSquare);
    if (playedMove != undefined) {
      registerPlayerMove(playedMove);
      selectedSquare = undefined;
      selectedPremoveColor = undefined;
      return;
    }
  }

  // An empty square can be a legal destination (handled above), but it must
  // never become a selected piece square.
  const selectedQueueColor = gameUI?.premoves?.color();
  const selectedPiece = chess.board.piecesList[currentSquare];
  const hasPiece = BBUtil.isBitSet(currentSquare, chess.board.piecesBB);

  // A queued follow-up may start on an empty square only when an earlier
  // premove is expected to place an allied piece there.
  if (selectedQueueColor !== undefined) {
    const hasAllyPiece = hasPiece && Piece.clr(selectedPiece) === selectedQueueColor;
    const isQueuedTarget = gameUI.premoves.items.some((premove) => premove.to === currentSquare);
    if (!hasAllyPiece && !isQueuedTarget) {
      selectedSquare = undefined;
      selectedPremoveColor = undefined;
      return;
    }
    selectedPremoveColor = selectedQueueColor;
  } else {
    if (!hasPiece) {
      selectedSquare = undefined;
      selectedPremoveColor = undefined;
      return;
    }
    const selectedPieceColor = Piece.clr(selectedPiece);
    if (selectedPieceColor === chess.clrToMove || !gameUI?.premoves?.canQueue(selectedPieceColor)) {
      selectedPremoveColor = undefined;
    } else {
      selectedPremoveColor = selectedPieceColor;
    }
  }

  selectToggle = !selectToggle;
  if (selectedSquare != currentSquare) selectToggle = false;
  selectedSquare = currentSquare;
}

function touchMoved() {
  if (!chess) return;
  if (chess.result == GameResult.starting) return;
  if (annotationDragStart != undefined) return updateBoardAnnotation(this.mouseX, this.mouseY);
  dragging = true;
}

function touchEnded() {
  if (!chess) return;
  if (chess.result == GameResult.starting) return;
  if (annotationDragStart != undefined) return finishBoardAnnotation(this.mouseX, this.mouseY);
  const wasDragging = dragging;
  dragging = false;
  if (selectedSquare == undefined) return;

  const { currentFile, currentRank, currentSquare } = getCurrentMouseCoords(this.mouseX, this.mouseY);

  if (BoardUtil.outOfBounds(currentFile, currentRank)) return;

  //If the promotion UI is active, don't get a new move
  if (promotionMenu.active) return;

  const playedMove = searchMoves(selectedSquare, currentSquare);
  const invalidDraggedMove = playedMove == undefined && wasDragging && currentSquare !== selectedSquare && !promotionMenu.active;
  if (playedMove != undefined) {
    registerPlayerMove(playedMove);
  } else if (invalidDraggedMove) {
    gameUI?.playInvalidMoveSound();
  }

  // A drag is not a selection-toggle click. Reset the toggle so a retained
  // selection can be cleared with one subsequent click.
  if (wasDragging) selectToggle = false;
  const clickedSelectedSquare = !wasDragging && currentSquare === selectedSquare && selectToggle;
  if (clickedSelectedSquare || (!invalidDraggedMove && currentSquare !== selectedSquare)) {
    selectedSquare = undefined;
    selectedPremoveColor = undefined;
  }
}

function registerPlayerMove(playedMove) {
  if (selectedPremoveColor !== undefined) {
    gameUI?.premoves.enqueue(selectedPremoveColor, Move.startSqr(playedMove), Move.targetSqr(playedMove));
    return;
  }
  //If bot is playing during a live game, don't allow moves
  if (!chess.originalGameConcluded && gameUI?.isBotTurn()) return;

  chess.playMove(playedMove);
}

function searchMoves(moveFrom, moveTo) {
  //Don't allow moves when game is over, unless the original game concluded and we are analyzing
  if (chess.result != GameResult.inProgress && !chess.originalGameConcluded) return undefined;

  // Premove legality is intentionally checked only after the opponent has
  // moved. This also lets a queued move use the destination of an earlier
  // queued move as its origin.
  if (selectedPremoveColor !== undefined && selectedPremoveColor !== chess.clrToMove) {
    return Move.newMove(moveFrom, moveTo);
  }

  // The bot may have moved after the user selected a premove piece. Once it
  // is that player's turn again, retain the selected square but resolve the
  // destination against the current legal move list like a normal move.
  selectedPremoveColor = undefined;

  const moveToFile = BoardUtil.squareToFile(moveTo);
  const moveToRank = BoardUtil.squareToRank(moveTo);
  //Looking for a move that matches with the user input
  for (let move of chess.moves) {
    const moveStartSqr = Move.startSqr(move);
    const moveTargetSqr = Move.targetSqr(move);
    if (moveStartSqr != moveFrom || moveTargetSqr != moveTo) continue;

    if (Move.isPromotion(move)) {
      const promotionDrawX = flipBoard ? boardSize - moveToFile * squareSize - squareSize : moveToFile * squareSize;
      let promotionDrawY = flipBoard ? boardSize - moveToRank * squareSize - squareSize : moveToRank * squareSize;
      const menuExtendsUp = (flipBoard && chess.clrToMove == white) || (!flipBoard && chess.clrToMove == black);
      if (menuExtendsUp) promotionDrawY -= (promotionMenu.options.length - 1) * squareSize;

      //Open promotion menu at the target square
      promotionMenu.active = true;
      promotionMenu.drawX = promotionDrawX;
      promotionMenu.drawY = promotionDrawY;
      promotionMenu.move = move;
      return undefined; //Wait for user to choose promotion
    }
    lastBestMove = undefined;
    return move; //Return the move if it wasn't a promotion
  }
  return undefined;
}

function handlePromotionClick(clickedFile, clickedRank) {
  selectedSquare = undefined;
  const { options, move } = promotionMenu;
  const promotionSquare = Move.targetSqr(move);
  const promotionMenuFile = BoardUtil.squareToFile(promotionSquare);

  if (clickedFile === promotionMenuFile) {
    const clickedDrawRank = flipBoard ? 7 - clickedRank : clickedRank;
    const promotionMenuDrawRank = promotionMenu.drawY / squareSize;
    const optionIndex = clickedDrawRank - promotionMenuDrawRank;
    if (optionIndex >= 0 && optionIndex < options.length) {
      const startSquare = Move.startSqr(move);
      const targetSquare = Move.targetSqr(move);

      const selected = options[optionIndex];
      let promotionFlag;
      switch (selected) {
        case knight:
          promotionFlag = promoteKnightFlag;
          break;
        case bishop:
          promotionFlag = promoteBishopFlag;
          break;
        case rook:
          promotionFlag = promoteRookFlag;
          break;
        case queen:
          promotionFlag = promoteQueenFlag;
          break;
      }

      promotionMenu.active = false;
      return Move.newMove(startSquare, targetSquare, promotionFlag);
    }
  }

  promotionMenu.active = false;
  return undefined;
}

//Returns the current square the mouse is hovering over, taking into account board flipping
function getCurrentMouseCoords(x, y) {
  const file = Math.floor(x / squareSize);
  const rank = Math.floor(y / squareSize);

  const realFile = flipBoard ? 7 - file : file;
  const realRank = flipBoard ? 7 - rank : rank;

  return {
    currentFile: realFile,
    currentRank: realRank,
    currentSquare: BoardUtil.indexToSquare(realFile, realRank),
  };
}

function keyPressed() {
  //Skip inputs if selecting a text field
  const active = document.activeElement;
  if (active.tagName == "INPUT" || active.tagName == "TEXTAREA") return;

  //Start the game
  if (key === " ") {
    const whiteBotCheckBox = document.getElementById("whiteBotBox");
    const blackBotCheckBox = document.getElementById("blackBotBox");

    gameUI.setBot(white, whiteBotCheckBox.checked ? capraStar : undefined);
    gameUI.setBot(black, blackBotCheckBox.checked ? capraStar : undefined);

    document.getElementById("overlay").style.display = "none";
    gameUI.startGame();
  }

  //Let CapraStar (AI) evaluate the current position
  if (key === "w") {
    console.log("Evaluating position with CapraStar...");
    capraStar.postMessage({
      type: "evaluate",
      fen: chess.board.toFEN(true),
      repetitionHistory: chess.board.repetitionHistory,
      ...(gameUI?.getSearchTimeControl(chess.clrToMove) || { timeRemainingMs: null, incrementMs: 0, moveTimeMs: 4000 }),
    });
  }

  //Clear the evaluation
  if (key === "s") {
    lastEval = 0;
    lastBestMove = null;
  }

  //Undo last move
  if (key === "a") {
    chess.undoMove();
  }

  //Redo last undone move
  if (key === "d") {
    chess.redoMove();
  }

  //Fetch current position's FEN
  if (key === "e") {
    FENTextField = document.getElementById("textTXT");
    FENTextField.value = chess.board.toFEN(true, true);
  }

  //Get move history
  if (key === "q") {
    let moveHistoryString = "";
    for (let i = 0; i < chess.moveHistory.length; i += 2) {
      moveHistoryString += floor(i * 0.5) + 1 + "-" + Move.toString(chess.moveHistory[i]) + " ";
      if (i + 1 < chess.moveHistory.length) moveHistoryString += Move.toString(chess.moveHistory[i + 1]) + "\n";
    }
    console.log(moveHistoryString);
  }

  /*Debug keybinds*/

  if (keyCode === UP_ARROW) {
    const captures = chess.moveGenerator.generateMoves(chess.board, true);
    for (let capture of captures) {
      Move.toString(capture);
    }
  }

  if (keyCode === DOWN_ARROW) {
    console.log(chess.moveGenerator.inCheck);
    console.log("All pieces");
    BBUtil.printBB(chess.board.piecesBB);
    console.log("Black pieces");
    BBUtil.printBB(chess.board.black.pieces);
    console.log("White pieces");
    BBUtil.printBB(chess.board.white.pieces);
    console.log(chess.board.toString());
    console.log("White pawns");
    BBUtil.printBB(chess.board.white.pawns);
    console.log("Black pawns");
    BBUtil.printBB(chess.board.black.pawns);
  }

  if (keyCode === LEFT_ARROW) {
    const board = chess.board;
    let phase = 0;
    const phaseValues = [0, 0, 1, 1, 2, 4, 0];
    const totalPhase = 24;
    phase += phaseValues[pawn] * (board.pieceCounts[white][pawn] + board.pieceCounts[black][pawn]);
    phase += phaseValues[knight] * (board.pieceCounts[white][knight] + board.pieceCounts[black][knight]);
    phase += phaseValues[bishop] * (board.pieceCounts[white][bishop] + board.pieceCounts[black][bishop]);
    phase += phaseValues[rook] * (board.pieceCounts[white][rook] + board.pieceCounts[black][rook]);
    phase += phaseValues[queen] * (board.pieceCounts[white][queen] + board.pieceCounts[black][queen]);
    //Clamping phase in case of weird positions
    if (phase < 0) phase = 0;
    if (phase > totalPhase) phase = totalPhase;
    console.log(totalPhase - phase);
  }

  if (keyCode === RIGHT_ARROW) {
    const blackPawns = chess.board.black.pawns;
    console.log((BBUtil.passedPawnMasks[white][33] & blackPawns) == 0);
    console.log((BBUtil.passedPawnMasks[white][36] & blackPawns) == 0);
    console.log((BBUtil.passedPawnMasks[white][38] & blackPawns) == 0);

    const whitePawns = chess.board.white.pawns;
    console.log((BBUtil.passedPawnMasks[black][9] & whitePawns) == 0);
    console.log((BBUtil.passedPawnMasks[black][11] & whitePawns) == 0);
    console.log((BBUtil.passedPawnMasks[black][39] & whitePawns) == 0);

    const squaresToEdgeWhite = BoardUtil.squareToRank(4);
    console.log(squaresToEdgeWhite);

    const squaresToEdgeBlack = 7 - BoardUtil.squareToRank(4);
    console.log(squaresToEdgeBlack);
  }

  if (key === "u") {
    const knightSqr = BoardUtil.nameToSquare("e4");
    const knightClr = white;
    const board = chess.board;

    const allyPawns = knightClr == white ? board.white.pawns : board.black.pawns;
    const enemyPawns = knightClr == white ? board.black.pawns : board.white.pawns;
    const otherClr = knightClr == white ? black : white;
    const knightFile = BoardUtil.squareToFile(knightSqr);
    const knightFileMask = BBUtil.fileMasks[knightFile];

    const enemyPawnsMask = BBUtil.passedPawnMask(knightSqr, knightClr) & ~knightFileMask;
    const pawnDefendersMask = BBUtil.pawnAttacks(knightSqr, otherClr);
    BBUtil.printBB(enemyPawnsMask);
    BBUtil.printBB(enemyPawnsMask, false);

    console.log((enemyPawnsMask & enemyPawns) == 0n && (pawnDefendersMask & allyPawns) != 0n);
  }

  if (key === "i") {
    console.log("Got:");
    console.log(chess.board.zobristKey.toString());
    console.log("Expected:");
    console.log(Zobrist.computeZobristHash(chess.board).toString());
  }

  if (key === "p") {
    const board = chess.board;
    const start = performance.now();
    const engineResults = perftDivide(board, 4);
    const end = performance.now();

    const stockFishMap = mapResults(stockfishResults);
    compareOutputs(engineResults, stockFishMap);
    console.log(`Execution time: ${end - start} ms`);
  }

  if (key === "o") {
    const movesString =
      "1-d2d4 g8f6 2-c1f4 b8c6 3-e2e3 f6d5 4-f4g3 e7e6 5-b1d2 d5f6 6-g1f3 d7d5 7-f1b5 c8d7 8-e1g1 f8d6 9-g3d6 c7d6 10-d1e2 d8b6 11-a2a3 a7a6 12-b5c6 d7c6 13-e2d3 e8g8 14-a1b1 a8e8 15-d3c3 f6e4 16-c3d3 e6e5 17-h2h3 e4f6 18-d3b3 b6a5 19-b1d1 e5e4 20-f3h4 c6a4 21-b3b7 a4c2 22-h4f5 c2d1 23-f1d1 e8b8 24-b7c6 b8b2 25-f5e7 g8h8 26-c6d6 b2d2 27-d1d2 a5d2 28-e7d5 d2d1 29-g1h2 f8a8 30-d5f6 g7f6 31-d6f6 h8g8 32-f6g5 g8f8 33-g5c5 f8g7 34-c5g5 g7h8 35-g5f6 h8g8 36-f6g5 g8f8 37-g5c5 f8g8 38-c5g5";
    const movePattern = /\b[a-h][1-8][a-h][1-8][qrbn]?\b/g;
    const moveArray = movesString.match(movePattern) || [];
    chess.board.init();
    chess.board.fillBoard(startFEN);
    for (let UCImove of moveArray) {
      console.log(UCImove);
      const move = Move.UCIToMove(UCImove, chess.board);
      chess.playMove(move);
    }
  }
}
