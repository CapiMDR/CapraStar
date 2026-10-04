let hintEnabled = false;
let hintRequestCounter = 0;
let activeHintRequestId = null;

function updateHintButton() {
  const hintBtn = document.getElementById("hintBTN");
  if (!hintBtn) return;

  hintBtn.classList.toggle("btn-glowing", hintEnabled);
  hintBtn.classList.toggle("hint-active", hintEnabled);
  hintBtn.setAttribute("aria-pressed", String(hintEnabled));
}

function clearHintPanel() {
  lastEval = 0;
  lastBestMove = null;
  updateHintPanel({ bestMove: null, depth: null, nodesSearched: null, timeTaken: null, pv: [] });
}

function startHintSearch() {
  if (!hintEnabled || !chess || !evaluator) return;
  const requestId = ++hintRequestCounter;
  activeHintRequestId = requestId;
  const fen = chess.board.toFEN(true, true);
  // Analysis must not consume or inherit the game clock.  The evaluator has
  // a predictable per-position budget, while the gameplay worker continues
  // to receive clock-derived limits from GameUIController.
  const timeControl = { timeRemainingMs: null, incrementMs: 0, moveTimeMs: 10000 };
  updateHintPanel({ bestMove: null, depth: "searching", nodesSearched: null, timeTaken: 0, pv: [] }, fen);

  evaluator.postMessage({
    type: "evaluate",
    fen,
    requestId,
    positionGeneration: chess.positionGeneration,
    ...timeControl,
  });
}

function onBoardPositionChanged() {
  clearHintPanel();
  if (hintEnabled) startHintSearch();
}

function updateTimers() {
  if (!gameUI || !gameUI.timers) return;
  const whiteBotCheckBox = document.getElementById("whiteBotBox");
  const blackBotCheckBox = document.getElementById("blackBotBox");
  gameUI.setPlayerName(white, whiteBotCheckBox.checked ? "CapraStar" : "User");
  gameUI.setPlayerName(black, blackBotCheckBox.checked ? "CapraStar" : "User");
}

function startGame() {
  const whiteBotCheckBox = document.getElementById("whiteBotBox");
  const blackBotCheckBox = document.getElementById("blackBotBox");

  //Setting bots through a script to allow for custom AI scripts to be used
  gameUI.setBot(white, whiteBotCheckBox.checked ? capraStar : undefined);
  gameUI.setBot(black, blackBotCheckBox.checked ? capraStar : undefined);
  deactivateUI();
  gameUI.startGame();
}

function activateUI() {
  document.getElementById("overlay").style.display = "flex";
  document.getElementById("setFenBTN").disabled = false;
  document.getElementById("setPgnBTN").disabled = false;
  document.getElementById("whiteTimerBTN").disabled = false;
  document.getElementById("blackTimerBTN").disabled = false;
  document.getElementById("whiteBotBox").disabled = false;
  document.getElementById("blackBotBox").disabled = false;
}

function deactivateUI() {
  document.getElementById("overlay").style.display = "none"; //Disabling shadow over canvas
  //Disabling some buttons
  document.getElementById("setFenBTN").disabled = true;
  document.getElementById("setPgnBTN").disabled = true;
  document.getElementById("whiteTimerBTN").disabled = true;
  document.getElementById("blackTimerBTN").disabled = true;
  document.getElementById("whiteBotBox").disabled = true;
  document.getElementById("blackBotBox").disabled = true;
}

function restartGame() {
  chess.restartGame();
  activateUI();
}

function redoMove() {
  chess.redoMove();
}

function undoMove() {
  chess.undoMove();
}

function goToFirstPosition() {
  chess.goToFirstPosition();
}

function goToLastPosition() {
  chess.goToLastPosition();
}

function getFEN() {
  const currentFEN = chess.board.toFEN(true, true);
  FENTextField = document.getElementById("textTXT");
  FENTextField.value = currentFEN;

  FENTextField.focus();
  FENTextField.select();

  try {
    document.execCommand("copy");
    console.log("Copied!");
  } catch (err) {
    console.log("Copy failed");
  }
}

function setFEN() {
  const FENTextField = document.getElementById("textTXT");
  FEN = FENTextField.value;
  if (FEN == "") {
    FENTextField.value = "Input valid FEN string here";
    return;
  }
  const fenValidity = chess.isValidFEN(FEN);
  if (fenValidity == "Valid FEN") {
    chess.loadFEN(FEN);
    FENTextField.value = "Position set!";
  } else {
    FENTextField.value = fenValidity;
  }
}

function setPGN() {
  const textField = document.getElementById("textTXT");
  inputText = textField.value;
  if (inputText == "" || inputText == "Input valid pgn moves list here") {
    textField.value = "Input valid pgn moves list here";
    return;
  }
  const movesString = inputText;
  restartGame();
  startGame();

  if (movesString == "") return;

  // Extract Result tag if present, e.g. [Result "1-0"]
  const resultMatch = movesString.match(/\[Result\s+"([^"]+)"\]/i);
  let pgnResult = resultMatch ? resultMatch[1].trim() : null;

  // Remove square bracket tags like [Event "..."]
  let sanitized = movesString.replace(/\[.*?\]/g, "");

  // Check for trailing result marker if not found in headers
  if (!pgnResult) {
    const trailingResultMatch = sanitized.match(/\b(1-0|0-1|1\/2-1\/2|\*)\b/);
    if (trailingResultMatch) pgnResult = trailingResultMatch[1];
  }

  // Remove result tokens so they aren't treated as moves
  sanitized = sanitized.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, "");
  // Remove comments in braces if present: { ... }
  sanitized = sanitized.replace(/\{.*?\}/gs, "");
  // Remove move numbers like "1-e4", "2.Nf3", "3...", etc.
  sanitized = sanitized.replace(/\d+[\.\-]+/g, "");

  // Split by whitespace to get individual SAN moves
  const sanMoves = sanitized
    .trim()
    .split(/\s+/)
    .filter((m) => m.length > 0);

  for (let sanMove of sanMoves) {
    // Convert SAN → UCI using SANToUCI method
    const uci = Move.SANToUCI(sanMove, chess.board);

    if (!uci) {
      console.warn("Could not convert SAN move:", sanMove);
      continue;
    }

    const move = Move.UCIToMove(uci, chess.board);
    chess.playMove(move);
  }

  // Determine game over result
  let finalResult = "Game Over";
  if (pgnResult === "1-0") finalResult = "1-0 (White won)";
  else if (pgnResult === "0-1") finalResult = "0-1 (Black won)";
  else if (pgnResult === "1/2-1/2") finalResult = "1/2-1/2 (Draw)";
  else if (pgnResult && pgnResult !== "*") finalResult = pgnResult;

  // End the game automatically so analysis mode is immediately available
  if (!chess.originalGameConcluded) {
    chess.endGame(finalResult);
  }

  deactivateUI();
}

//Copies all moves that have been played to the clipboard
function getPGN() {
  const FENTextField = document.getElementById("textTXT");

  const today = new Date();
  const pgnDate = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;

  //Defaulting to 5 mins + 3 if no timers
  const whiteTimer = gameUI.timers[white];
  const pgnTimeControl = whiteTimer ? (whiteTimer.isUnlimited ? "-" : whiteTimer.initialTime + "+" + whiteTimer.increment) : "300+3";

  //1-0 if white wins, 0-1 if black wins, 1/2-1/2 if draw
  const gameRes = chess.originalGameConcluded ? chess.originalResult : chess.result;
  const result =
    gameRes == GameResult.blackCheckmated || gameRes == GameResult.blackTimeOut || gameRes == "0-1" || String(gameRes).startsWith("0-1")
      ? "0-1"
      : gameRes == GameResult.whiteCheckmated || gameRes == GameResult.whiteTimeOut || gameRes == "1-0" || String(gameRes).startsWith("1-0")
        ? "1-0"
        : "1/2-1/2";

  const { whitePlayer, blackPlayer } = gameUI.getPlayers();
  let pgn = `[Event "Casual game"] [Site "CapraChess Arena"] [Date "${pgnDate}"] [White "${whitePlayer}"] [Black "${blackPlayer}"] [Result "${result}"] [TimeControl "${pgnTimeControl}"] `;

  const allMoves =
    chess.originalGameConcluded && chess.originalSANMoves?.length > 0
      ? chess.originalSANMoves
      : [...chess.moveSANHistory, ...chess.redoSANHistory.slice().reverse()];
  for (let i = 0; i < allMoves.length; i += 2) {
    pgn += i / 2 + 1 + ". " + allMoves[i] + " ";
    if (allMoves[i + 1]) pgn += allMoves[i + 1] + " ";
  }

  pgn = pgn.trim();

  FENTextField.value = pgn;

  FENTextField.focus();
  FENTextField.select();

  try {
    document.execCommand("copy");
    console.log("Copied!");
  } catch (err) {
    console.log("Copy failed");
  }
}

function updateHintPanel(data, fen = chess.board.toFEN(true, true)) {
  const bestMoveEl = document.getElementById("hintBestMove");
  const evaluationEl = document.getElementById("hintEvaluation");
  const depthEl = document.getElementById("hintDepth");
  const nodesEl = document.getElementById("hintNodes");
  const timeEl = document.getElementById("timeTaken");
  const pvEl = document.getElementById("hintPV");

  if (!bestMoveEl || !evaluationEl || !depthEl || !nodesEl || !timeEl || !pvEl) return;

  let bestSAN;
  if (data && data.bestMove) {
    const tmpBoard = new Board();
    tmpBoard.fillBoard(fen);
    const bestUCI = Move.toString(data.bestMove);
    bestSAN = Move.UCIToSAN(bestUCI, tmpBoard);
  }

  const moveText = bestSAN ? bestSAN : "-";

  let evalText;
  if (data.isBookMove) {
    evalText = "Book Move";
  } else {
    //Only use checkmate result on the last position, regular evaluation otherwise
    evalText = chess.redoHistory.length == 0 ? getCheckmateResultText(chess) : null;
    if (!evalText) {
      if (data?.evaluation != null) {
        if (Math.abs(data.evaluation) > mateScore - 1000) {
          const movesTillMate = floor((mateScore - abs(data.evaluation)) * 0.5);
          evalText = movesTillMate >= 0 ? "M" + (movesTillMate + 1) : "1-0";
        } else {
          evalText = (data.evaluation * 0.01).toFixed(1);
          evalText = chess.board.clrToMove == white ? evalText : -evalText;
        }
      } else {
        evalText = "-";
      }
    }
  }

  const depth = data?.depth != null ? data.depth : "-";
  const nodes = Number.isFinite(data?.nodesSearched) ? data.nodesSearched.toLocaleString() : "-";
  const timeTaken = data?.timeTaken != null ? data.timeTaken.toFixed(2) + " ms" : "-";

  bestMoveEl.textContent = moveText;
  evaluationEl.textContent = evalText;
  depthEl.textContent = depth;
  nodesEl.textContent = nodes;
  timeEl.textContent = timeTaken;

  if (Array.isArray(data?.pv) && data.pv.length > 0) {
    //Printing the moves from the principal variation (pv) on the UI
    //Start from the current FEN position, convert each move to SAN and play it on a temp board
    let pvText = "";
    const tempBoard = new Board();
    tempBoard.fillBoard(fen);
    for (const move of data.pv) {
      //Convert move to SAN (standard algebraic notation)
      const uciMove = Move.toString(move);
      const sanMove = Move.UCIToSAN(uciMove, tempBoard);
      tempBoard.makeMove(move);
      if (!sanMove) return; //Invalid move, skip
      pvText += sanMove + " ";
    }
    pvEl.textContent = pvText.trim();
  } else if (moveText !== "-") {
    pvEl.textContent = moveText;
  } else {
    pvEl.textContent = "-";
  }
}

function getHint() {
  hintEnabled = !hintEnabled;
  updateHintButton();

  if (hintEnabled) {
    startHintSearch();
  } else {
    activeHintRequestId = null;
    hintRequestCounter++;
  }
}

function unglowHintButton() {
  const hintBtn = document.getElementById("hintBTN");
  if (hintBtn) {
    hintBtn.classList.remove("btn-glowing");
    hintBtn.disabled = false;
  }
}

function flipGame() {
  flipBoard = !flipBoard;

  const timerPanel = document.getElementById("timerPanel");
  const whiteTimerBox = document.getElementById("whiteTimerBox");
  const blackTimerBox = document.getElementById("blackTimerBox");
  const gameStatus = document.getElementById("gameStatus");

  if (!timerPanel || !whiteTimerBox || !blackTimerBox || !gameStatus) return;

  if (flipBoard) {
    timerPanel.insertBefore(whiteTimerBox, blackTimerBox);
    timerPanel.insertBefore(gameStatus, blackTimerBox);
  } else {
    timerPanel.insertBefore(blackTimerBox, whiteTimerBox);
    timerPanel.insertBefore(gameStatus, whiteTimerBox);
  }

  syncCapturedTrayOrientation();
}

function syncCapturedTrayOrientation() {
  const topTray = document.getElementById("capturedPiecesTop");
  const bottomTray = document.getElementById("capturedPiecesBottom");

  if (!topTray || !bottomTray) return;

  if (flipBoard) {
    topTray.style.top = "auto";
    topTray.style.bottom = "-52px";
    bottomTray.style.bottom = "auto";
    bottomTray.style.top = "-52px";
  } else {
    topTray.style.top = "-52px";
    topTray.style.bottom = "auto";
    bottomTray.style.bottom = "-52px";
    bottomTray.style.top = "auto";
  }
}

let showHelpMenu = false;
function toggleHelpMenu() {
  const helpMenu = document.getElementById("helpMenu");
  showHelpMenu = !showHelpMenu;

  if (showHelpMenu) {
    helpMenu.style.display = "flex";
    requestAnimationFrame(() => helpMenu.classList.add("visible"));
    return;
  }

  helpMenu.classList.remove("visible");
  setTimeout(() => {
    helpMenu.style.display = "none";
  }, 300);
}

function applyTimerPreset(color, minutes, increment, unlimited = false) {
  if (!gameUI || !gameUI.timers) return;

  const timerKey = color === "white" ? white : black;
  const timer = gameUI.timers[timerKey];
  if (!timer) return;

  timer.setTimeControl(minutes, increment, unlimited);
}

function closeTimerMenus() {
  document.querySelectorAll(".timerMenu").forEach((menu) => {
    menu.classList.remove("open");
    const button = document.querySelector(`.timerMenuBtn[data-color="${menu.dataset.color}"]`);
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".timerMenuBtn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = document.querySelector(`.timerMenu[data-color="${button.dataset.color}"]`);
      if (!menu) return;

      const isOpen = menu.classList.contains("open");
      closeTimerMenus();

      if (!isOpen) {
        menu.classList.add("open");
        button.setAttribute("aria-expanded", "true");
      }
    });
  });

  document.querySelectorAll(".timerMenuOption").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const color = button.dataset.color;
      const minutes = Number(button.dataset.minutes || 0);
      const increment = Number(button.dataset.increment || 0);
      const unlimited = button.dataset.unlimited === "true";

      applyTimerPreset(color, minutes, increment, unlimited);
      closeTimerMenus();
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".timerMenuBtn") && !event.target.closest(".timerMenu") && !event.target.closest(".timerMenuOption")) {
      closeTimerMenus();
    }
  });
});
