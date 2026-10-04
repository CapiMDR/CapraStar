let boardSize = 700;
const MAX_BOARD_SIZE = 700;
const MIN_BOARD_SIZE = 400;
const evalBarThickness = 25;
const UISize = 400;
let squareSize = boardSize / 8;
const UICenter = boardSize + (UISize + evalBarThickness) * 0.5;
const startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let chess;
let gameUI;
let capraStar;
let evaluator;
let flipBoard = false;

/**
 * Calculate optimal board size based on the actual layout used at the current viewport.
 * Mobile layouts stack the board vertically, so they must use the visible viewport width
 * rather than the desktop sidebar assumptions.
 */
function calculateBoardSize() {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const isPortrait = window.matchMedia("(orientation: portrait)").matches;

  // Mobile / stacked layout: board is the full visible width, not desktop sidebar width.
  if (viewportWidth <= 1000 || isPortrait) {
    const mobileWidth = Math.min(viewportWidth - 24, 600);
    return Math.max(320, Math.floor(mobileWidth));
  }

  const leftColumn = document.getElementById("leftColumn")?.offsetWidth || 200;
  const timerPanel = document.getElementById("timerPanel")?.offsetWidth || 200;
  const gap = 48;
  const availableWidth = viewportWidth - (leftColumn + timerPanel + gap);
  const availableHeight = viewportHeight - 240;

  let calculatedSize = Math.min(availableWidth, availableHeight, MAX_BOARD_SIZE);
  calculatedSize = Math.max(MIN_BOARD_SIZE, calculatedSize);

  return Math.floor(calculatedSize);
}

/**
 * Update CSS variable for board size to sync with canvas
 */
function updateBoardSizeVariable() {
  const newBoardSize = calculateBoardSize();
  const cssValue = newBoardSize + "px";
  document.documentElement.style.setProperty("--board-size", cssValue);
}

//Loading help menu content at runtime
window.addEventListener("DOMContentLoaded", async () => {
  const response = await fetch("help.html");
  const html = await response.text();

  document.getElementById("helpMenu").innerHTML = html;
});

function preload() {
  const IMG_PATH = "./public/assets/images/merida/";
  const IMG_EXTENSION = ".svg";

  wP_Icon = loadImage(`${IMG_PATH}wP${IMG_EXTENSION}`);
  wN_Icon = loadImage(`${IMG_PATH}wN${IMG_EXTENSION}`);
  wB_Icon = loadImage(`${IMG_PATH}wB${IMG_EXTENSION}`);
  wR_Icon = loadImage(`${IMG_PATH}wR${IMG_EXTENSION}`);
  wQ_Icon = loadImage(`${IMG_PATH}wQ${IMG_EXTENSION}`);
  wK_Icon = loadImage(`${IMG_PATH}wK${IMG_EXTENSION}`);

  bP_Icon = loadImage(`${IMG_PATH}bP${IMG_EXTENSION}`);
  bN_Icon = loadImage(`${IMG_PATH}bN${IMG_EXTENSION}`);
  bB_Icon = loadImage(`${IMG_PATH}bB${IMG_EXTENSION}`);
  bR_Icon = loadImage(`${IMG_PATH}bR${IMG_EXTENSION}`);
  bQ_Icon = loadImage(`${IMG_PATH}bQ${IMG_EXTENSION}`);
  bK_Icon = loadImage(`${IMG_PATH}bK${IMG_EXTENSION}`);

  capture_Sound = loadSound("public/assets/sounds/captures.mp3");
  move_Sound = loadSound("public/assets/sounds/move.mp3");
  check_Sound = loadSound("public/assets/sounds/check.mp3");
  gameOver_Sound = loadSound("public/assets/sounds/gameOver.mp3");
  castle_Sound = loadSound("public/assets/sounds/castle.mp3");
  start_Sound = loadSound("public/assets/sounds/start.mp3");
  lowTime_Sound = loadSound("public/assets/sounds/lowTime.mp3");
  lowTime_Sound.setVolume(0.06);
  invalidMove_Sound = loadSound("public/assets/sounds/invalidMove.mp3");
  invalidMove_Sound.setVolume(0.2);

  check_Glow = loadImage("public/assets/images/Glow.png");

  bookEntries = loadStrings("public/data/Book.txt");
}

function setup() {
  // Calculate responsive board size
  boardSize = calculateBoardSize();
  squareSize = boardSize / 8;
  updateBoardSizeVariable();

  const cnv = createCanvas(boardSize + evalBarThickness, boardSize);
  cnv.parent("canvasContainer");

  syncCapturedTrayOrientation();

  /* Web workers for AIs */
  const ver = Date.now();
  capraStar = new Worker(`src/worker/CapraWorker.js?v=${ver}`);

  capraStar.onmessage = function (e) {
    switch (e.data.type) {
      case "result":
        if (e.data.positionGeneration !== chess.positionGeneration) return;
        // A search can complete after its clock has expired. Do not let that
        // stale bot result revive the game (or trigger end-of-game feedback a
        // second time).
        if (chess.result !== GameResult.inProgress || chess.originalGameConcluded) return;
        chess.playMove(e.data.bestMove);

        //console.log("Depth: " + e.data.depth + " Time: " + e.data.timeTaken);
        //console.log("BestMove: " + Move.toString(e.data.bestMove) + " PV:");
        //let l = "";
        //for (move of e.data.pv) {
        //  l += Move.toString(move) + " ";
        //}
        //console.log(l);
        break;
      default:
        console.log("Worker log: " + e.data.msg);
    }
  };

  openingBook = loadBookMoveEntries(bookEntries);
  capraStar.postMessage({
    type: "init",
    book: openingBook,
  });

  createEvaluatorWorker(ver);

  /* Game logic */
  chess = new Engine(startFEN);
  gameUI = new GameUIController(chess, { botWorker: capraStar, onPositionChanged: onBoardPositionChanged });
}

// The evaluator stays alive between positions so it can retain its search caches.
function createEvaluatorWorker(version = Date.now()) {
  evaluator = new Worker(`src/worker/CapraWorker.js?v=${version}`);
  evaluator.onmessage = function (e) {
    switch (e.data.type) {
      case "evaluation":
        if (!hintEnabled || e.data.requestId !== activeHintRequestId || e.data.positionGeneration !== chess.positionGeneration) return;
        const evaluatedBoard = new Board();
        evaluatedBoard.fillBoard(e.data.fen);
        lastEval = evaluatedBoard.clrToMove == white ? e.data.evaluation : -e.data.evaluation;
        lastBestMove = e.data.bestMove;
        updateHintPanel(e.data, e.data.fen);
        break;
      default:
        console.log("Worker log: " + e.data.msg);
    }
  };
  evaluator.postMessage({ type: "init", book: openingBook });
}

/**
 * Handle window resize events - recalculate and redraw canvas responsively
 */
function windowResized() {
  // Calculate new board size based on current viewport
  const newBoardSize = calculateBoardSize();

  // Only resize if size actually changed (avoid unnecessary redraws)
  if (newBoardSize !== boardSize) {
    boardSize = newBoardSize;
    squareSize = boardSize / 8;
    resizeCanvas(boardSize + evalBarThickness, boardSize);
    updateBoardSizeVariable();
  }
}

function draw() {
  //background(251,251,251);
  background(245);
  drawBoard();
  drawAnalysisTint(chess);
  highlightSquares(chess, color(45, 221, 162, 180), color(211, 42, 50, 180));
  drawPremoveIndicators();
  drawBoardCircles();
  drawCheckBubble(chess);

  drawLegalMoves(chess, color(18, 221, 162));
  drawPieces(chess);
  drawBoardArrows();
  //debugView(chess);
  drawBestMoveArrow();

  drawUIText(chess);

  renderCapturedPiecesDOM(chess);
  if (promotionMenu.active) drawPromotionUI(chess);
  drawBotEval(chess);
  drawDraggedPiece(chess);

  //Undo last move - rewind (z key)
  if (keyIsDown(90)) {
    chess.undoMove();
  }

  //Redo last undone move - fastforward (x key)
  if (keyIsDown(88)) {
    chess.redoMove();
  }
}

// A light wash distinguishes an uncommitted analysis variation from the played game.
function drawAnalysisTint(engine) {
  if (!engine.isAnalyzing) return;

  noStroke();
  fill(255, 80);
  rectMode(CORNER);
  rect(0, 0, boardSize, boardSize);
}

// Premove targets remain visible while their queue is waiting to be played.
function drawPremoveIndicators() {
  if (!gameUI?.premoves?.hasItems()) return;
  noStroke();
  fill(116, 74, 198, 105);
  for (const premove of gameUI.premoves.items) {
    const file = adjustFile(BoardUtil.squareToFile(premove.to));
    const rank = adjustRank(BoardUtil.squareToRank(premove.to));
    rect(file * squareSize, rank * squareSize, squareSize, squareSize);
  }
}

function drawBoard() {
  noStroke();
  rectMode(CORNER);
  const labelSize = Math.max(10, Math.min(18, Math.floor(boardSize / 35)));
  textSize(labelSize);
  textAlign(CENTER);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const drawFile = adjustFile(f);
      const drawRank = adjustRank(r);

      //Squares
      isLightSquare = BoardUtil.isLightSquare(f, r);
      fill(isLightSquare ? 240 : 100);
      rect(drawFile * squareSize, drawRank * squareSize, squareSize, squareSize);

      //Text
      fill(isLightSquare ? 100 : 240);
      if (!flipBoard) {
        if (f === 0) text(8 - r, squareSize * 0.17, squareSize * r + squareSize * 0.25 + labelSize * 0.4);
        if (r === 7) text(String.fromCharCode(97 + f), squareSize * f + squareSize * 0.82, height - squareSize * 0.12);
      } else {
        if (f === 7) text(8 - r, squareSize * 0.17, squareSize * (7 - r) + squareSize * 0.25 + labelSize * 0.4);
        if (r === 7) text(String.fromCharCode(104 - f), squareSize * f + squareSize * 0.82, height - squareSize * 0.12);
      }
    }
  }
}

function drawPieces(engine) {
  const board = engine.board;
  imageMode(CENTER);
  let allPieces = board.piecesBB;
  while (allPieces != 0n) {
    const sqr = BBUtil.getLSBIndex(allPieces);
    allPieces &= allPieces - 1n;
    //Skip if drawing dragged piece (handled later)
    if (dragging && sqr == selectedSquare) continue;
    const file = BoardUtil.squareToFile(sqr);
    const rank = BoardUtil.squareToRank(sqr);
    const piece = board.piecesList[sqr];
    const img = getImageFromPiece(piece);

    const drawFile = adjustFile(file) * squareSize + squareSize / 2;
    const drawRank = adjustRank(rank) * squareSize + squareSize / 2;

    image(img, drawFile, drawRank, squareSize, squareSize);
  }
}

function drawDraggedPiece(engine) {
  if (selectedSquare == undefined) return;
  if (!dragging) return;
  if (!BBUtil.isBitSet(selectedSquare, engine.board.piecesBB)) return;
  const piece = engine.board.piecesList[selectedSquare];
  let img = getImageFromPiece(piece);

  image(img, mouseX, mouseY, squareSize * 1.2, squareSize * 1.2);
}

const topTray = document.getElementById("capturedPiecesTop");
const bottomTray = document.getElementById("capturedPiecesBottom");

const capturedPieceDOMCache = new Map();
let lastCapturedTrayMarkup = { top: "", bottom: "" };

function renderCapturedPiecesDOM(engine) {
  if (!topTray || !bottomTray) return;

  const whiteCaptured = [];
  const blackCaptured = [];

  for (const piece of Piece.indeces) {
    const count = engine.capturedPieceCounts[piece];
    if (count <= 0) continue;

    const target = Piece.clr(piece) == white ? whiteCaptured : blackCaptured;
    for (let i = 0; i < count; i++) target.push(piece);
  }

  // Calculate piece icon size based on current board size (scale from 32x32 base)
  const pieceIconSize = Math.max(20, Math.min(32, Math.floor((boardSize / 700) * 32)));

  const toDataUri = (piece) => {
    const cacheKey = `${Piece.clr(piece)}-${Piece.type(piece)}-${pieceIconSize}`;
    if (!capturedPieceDOMCache.has(cacheKey)) {
      const img = getImageFromPiece(piece);
      const g = createGraphics(pieceIconSize, pieceIconSize);
      g.image(img, 0, 0, pieceIconSize, pieceIconSize);
      capturedPieceDOMCache.set(cacheKey, g.elt.toDataURL("image/png"));
    }
    return capturedPieceDOMCache.get(cacheKey);
  };

  const whiteTotalValue = engine.whiteMaterial;
  const blackTotalValue = engine.blackMaterial;
  const materialDiff = whiteTotalValue - blackTotalValue;
  const advantage = Math.abs(materialDiff);

  const buildTrayMarkup = (capturedPieces, isLeadingSide = false) => {
    const piecesMarkup = capturedPieces
      .map((piece) => `<span class="capturedPiece"><img src="${toDataUri(piece)}" alt="captured piece"></span>`)
      .join("");

    if (!isLeadingSide || advantage === 0) return piecesMarkup;

    return `${piecesMarkup}<span class="capturedValue">${advantage}</span>`;
  };

  const topMarkup = buildTrayMarkup(whiteCaptured, materialDiff < 0);
  const bottomMarkup = buildTrayMarkup(blackCaptured, materialDiff > 0);

  if (topTray.innerHTML !== topMarkup || bottomTray.innerHTML !== bottomMarkup) {
    topTray.innerHTML = topMarkup;
    bottomTray.innerHTML = bottomMarkup;
    lastCapturedTrayMarkup.top = topMarkup;
    lastCapturedTrayMarkup.bottom = bottomMarkup;
  }
}

function drawLegalMoves(engine, clr = color(0)) {
  //If bot is playing during a live game, don't show legal moves
  if (!engine.originalGameConcluded && gameUI?.isBotTurn()) return;
  //Don't show legal moves when game is over, unless analyzing post-game
  if (engine.result != GameResult.inProgress && !engine.originalGameConcluded) return;

  fill(clr);
  noStroke();
  strokeWeight(1);
  for (let move of engine.moves) {
    if (Move.startSqr(move) !== selectedSquare) continue;

    const drawFile = BoardUtil.squareToFile(Move.targetSqr(move));
    const drawRank = BoardUtil.squareToRank(Move.targetSqr(move));
    const x = adjustFile(drawFile) * squareSize + squareSize / 2;
    const y = adjustRank(drawRank) * squareSize + squareSize / 2;

    if (Move.isCapture(move, engine.board) && Move.flag(move) !== enPassantFlag) {
      noFill();
      stroke(clr);
      strokeWeight(squareSize * 0.13);
      ellipse(x, y, squareSize * 0.7, squareSize * 0.7);
    } else {
      noStroke();
      fill(clr);
      ellipse(x, y, squareSize * 0.4);
    }
  }
}

function getImageFromPiece(piece) {
  const pieceType = Piece.type(piece);
  const pieceColor = Piece.clr(piece);
  let img;
  switch (pieceType) {
    case pawn:
      img = pieceColor == white ? wP_Icon : bP_Icon;
      break;
    case knight:
      img = pieceColor == white ? wN_Icon : bN_Icon;
      break;
    case bishop:
      img = pieceColor == white ? wB_Icon : bB_Icon;
      break;
    case rook:
      img = pieceColor == white ? wR_Icon : bR_Icon;
      break;
    case queen:
      img = pieceColor == white ? wQ_Icon : bQ_Icon;
      break;
    case king:
      img = pieceColor == white ? wK_Icon : bK_Icon;
      break;
  }
  return img;
}

function highlightSquares(engine, selectedClr = color(0), moveClr = color(0)) {
  noStroke();
  //Highlighting selected piece original square
  if (selectedSquare != undefined) {
    fill(selectedClr);
    const selectedFile = adjustFile(BoardUtil.squareToFile(selectedSquare));
    const selectedRank = adjustRank(BoardUtil.squareToRank(selectedSquare));
    rect(selectedFile * squareSize, selectedRank * squareSize, squareSize, squareSize);
  }

  //Highlighting last move's start and target squares
  if (engine.moveHistory.length == 0) return;
  const lastMove = engine.moveHistory[engine.moveHistory.length - 1];
  const startSquare = Move.startSqr(lastMove);
  const targetSquare = Move.targetSqr(lastMove);

  const [sf, sr, tf, tr] = [
    adjustFile(BoardUtil.squareToFile(startSquare)),
    adjustRank(BoardUtil.squareToRank(startSquare)),
    adjustFile(BoardUtil.squareToFile(targetSquare)),
    adjustRank(BoardUtil.squareToRank(targetSquare)),
  ];

  fill(moveClr);
  rect(sf * squareSize, sr * squareSize, squareSize, squareSize);
  rect(tf * squareSize, tr * squareSize, squareSize, squareSize);
}

function drawCheckBubble(engine) {
  if (!engine.moveGenerator.inCheck) return;
  imageMode(CENTER);
  const kingBB = engine.clrToMove == white ? engine.board.white.king : engine.board.black.king;
  const kingSqr = BBUtil.getLSBIndex(kingBB);
  const kingFile = adjustFile(BoardUtil.squareToFile(kingSqr));
  const kingRank = adjustRank(BoardUtil.squareToRank(kingSqr));
  tint(255, 0, 0);
  const drawFile = kingFile * squareSize + squareSize * 0.5;
  const drawRank = kingRank * squareSize + squareSize * 0.5;
  image(check_Glow, drawFile, drawRank, squareSize * 2, squareSize * 2);
  noTint();
}

function drawUIText(engine) {
  const statusEl = document.getElementById("gameStatus");
  if (!statusEl) return;
  if (engine.isAnalyzing) {
    statusEl.textContent = `Analysis (${engine.analysisMoves.length} move${engine.analysisMoves.length === 1 ? "" : "s"})`;
  } else if (engine.originalGameConcluded && engine.redoHistory.length > 0) {
    statusEl.textContent = "Analysis: Reviewing Game";
  } else {
    statusEl.textContent = engine.result;
  }
}

let promotionMenu = {
  active: false,
  x: 0,
  y: 0,
  move: null,
  options: [5, 4, 3, 2],
};

function drawPromotionUI(engine) {
  fill(255);
  stroke(0);
  strokeWeight(2);
  rectMode(CORNER);
  imageMode(CENTER);
  const { drawX, drawY, options } = promotionMenu;
  for (let i = 0; i < options.length; i++) {
    rect(drawX, drawY + i * squareSize, squareSize, squareSize);
    const img = getImageFromPiece(Piece.newPiece(options[i], engine.clrToMove));
    const drawFile = drawX + squareSize / 2;
    const drawRank = drawY + i * squareSize + squareSize / 2;
    image(img, drawFile, drawRank, squareSize, squareSize);
  }
}

let currentEval = 0; //Evaluation shown currently on the bar (used to interpolate to lastEval for smooth animation)
let lastEval = 0; //Evaluation given by the bot for the current position
const mateScore = 10000000; //The highest score a bot can give to a move (mate next move)

function getCheckmateResultText(engine) {
  if (!engine) return null;
  if (engine.result == GameResult.whiteCheckmated) return "1-0";
  if (engine.result == GameResult.blackCheckmated) return "0-1";
  return null;
}

//Draws CapraStar's evaluation if active
function drawBotEval(engine) {
  const bestEvaluation = 900; //How "great" should the evaluation be to cover the entire bar

  currentEval = lerp(currentEval, lastEval, 0.05);

  //Only use checkmate result on the last position, regular evaluation otherwise
  let evalText = engine.redoHistory.length == 0 ? getCheckmateResultText(engine) : null;
  if (evalText) {
    // A completed game is shown as a result, not as a mate prediction.
  } else if (Math.abs(lastEval) > mateScore - 1000) {
    const movesTillMate = floor((mateScore - abs(lastEval)) * 0.5);
    evalText = movesTillMate >= 0 ? "M" + (movesTillMate + 1) : "1-0";
  } else {
    evalText = abs(lastEval * 0.01).toFixed(1);
  }

  noStroke();
  rectMode(CORNER);
  fill(0);
  rect(boardSize, 0, evalBarThickness, height);
  fill(255);
  rect(boardSize, height, evalBarThickness, map(currentEval, -bestEvaluation, bestEvaluation, 0, -height));

  const labelSize = Math.min(10, Math.min(18, Math.floor(boardSize / 35)));
  textSize(labelSize);
  textAlign(CENTER);
  if (lastEval >= 0) {
    fill(0);
    text(evalText, boardSize + evalBarThickness * 0.5, height - 20);
  } else {
    fill(255);
    text(evalText, boardSize + evalBarThickness * 0.5, 20);
  }
}

//Draws arrow between two squares
function drawArrow(fromSq, toSq, clr = color(0)) {
  //Convert square index into x,y coordinates (center of square)
  const fromFile = adjustFile(BoardUtil.squareToFile(fromSq));
  const fromRank = adjustRank(BoardUtil.squareToRank(fromSq));
  const toFile = adjustFile(BoardUtil.squareToFile(toSq));
  const toRank = adjustRank(BoardUtil.squareToRank(toSq));

  let x1 = fromFile * squareSize + squareSize / 2;
  let y1 = fromRank * squareSize + squareSize / 2; // flip rank for drawing
  let x2 = toFile * squareSize + squareSize / 2;
  let y2 = toRank * squareSize + squareSize / 2;

  //Draw line
  stroke(clr);
  strokeWeight(8);
  line(x1, y1, x2, y2);

  //Draw arrowhead
  let angle = atan2(y1 - y2, x1 - x2);
  push();
  translate(x2, y2);
  rotate(angle - HALF_PI);
  noStroke();
  fill(clr);
  triangle(-20, 20, 20, 20, 0, -10); // arrowhead size
  pop();
}

let lastBestMove = null;

//Draws an arrow for the recommended move by CapraStar
function drawBestMoveArrow() {
  if (lastBestMove == null) return;
  const startSquare = Move.startSqr(lastBestMove);
  const targetSquare = Move.targetSqr(lastBestMove);
  drawArrow(startSquare, targetSquare, color(237, 34, 93));
}

/*Debug functions*/

function debugView(engine) {
  const board = engine.board;
  const moveGenerator = engine.moveGenerator;

  if (engine.result != GameResult.starting) {
    //drawBB(moveGenerator.enemyAttacksMask, color(255,0,0,180));
    //drawBB(moveGenerator.pinRaysMask, color(255,0,255,180));
    //drawBB(moveGenerator.checkRaysMask, color(255,0,255,180));
    drawBB(moveGenerator.enemyPawnAttacksMask, color(255, 0, 255, 180));
  }

  drawBB(board.white.pawns, color(255, 0, 0, 180), color(255));
  drawBB(board.white.knights, color(245, 135, 0, 180), color(255));
  drawBB(board.white.bishops, color(245, 245, 0, 180), color(255));
  drawBB(board.white.rooks, color(70, 245, 0, 180), color(255));
  drawBB(board.white.queens, color(0, 245, 245, 180), color(255));
  drawBB(board.white.king, color(245, 0, 245, 180), color(255));

  drawBB(board.black.pawns, color(255, 0, 0, 180), color(0));
  drawBB(board.black.knights, color(245, 135, 0, 180), color(0));
  drawBB(board.black.bishops, color(245, 245, 0, 180), color(0));
  drawBB(board.black.rooks, color(70, 245, 0, 180), color(0));
  drawBB(board.black.queens, color(0, 245, 245, 180), color(0));
  drawBB(board.black.king, color(245, 0, 245, 180), color(0));
  printDebugText();
}

function printDebugText() {
  textAlign(CENTER, CENTER);
  textSize(14);
  noStroke();
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      pos = createVector(squareSize * i, squareSize * j);
      fill(255, 0, 255);
      text(8 * j + i, pos.x + 10, pos.y + 55);
      fill(0, 190, 255);
      text(i + "," + j, pos.x + 48, pos.y + 55);
      const sqr = BoardUtil.indexToSquare(i, j);
      fill(255, 190, 0);
      text(BoardUtil.sqrToString(sqr), pos.x + 48, pos.y + 15);
    }
  }
}

function drawBB(BB, clr = color(0), strokeClr = color(150)) {
  if (strokeClr != undefined) {
    stroke(strokeClr);
    strokeWeight(4);
  }
  fill(clr);
  while (BB != 0n) {
    const sqr = BBUtil.getLSBIndex(BB);
    const file = BoardUtil.squareToFile(sqr);
    const rank = BoardUtil.squareToRank(sqr);
    ellipse(file * squareSize + squareSize / 2, rank * squareSize + squareSize / 2, squareSize * 0.4);
    BB &= BB - 1n;
  }
}

function adjustFile(file) {
  return flipBoard ? 7 - file : file;
}

function adjustRank(rank) {
  return flipBoard ? 7 - rank : rank;
}

function setShadow() {
  //Access the canvas 2D context
  drawingContext.shadowOffsetX = 5;
  drawingContext.shadowOffsetY = 5;
  drawingContext.shadowBlur = 15;
  drawingContext.shadowColor = "rgba(0, 0, 0, 0.3)";
}

function setGlow() {
  drawingContext.shadowOffsetX = 0;
  drawingContext.shadowOffsetY = 0;
  drawingContext.shadowBlur = 30;
  drawingContext.shadowColor = "rgba(255, 255, 255, 0.2)";
}

function unsetEffects() {
  drawingContext.shadowBlur = 0;
  drawingContext.shadowOffsetX = 0;
  drawingContext.shadowOffsetY = 0;
  drawingContext.shadowColor = 0;
}
