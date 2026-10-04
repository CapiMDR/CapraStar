// Presentation adapter for a chess Engine. This is deliberately the only
// place where game events are connected to browser APIs, clocks, workers, and
// audiovisual feedback.
class GameUIController {
  constructor(engine, { botWorker, onPositionChanged } = {}) {
    this.engine = engine;
    this.bots = [undefined, undefined];
    this.playerNames = ["CapraStar", "User"];
    this.onPositionChanged = onPositionChanged;
    this.timers = [undefined, undefined];
    this.gameEndedByTimeout = false;
    this.premoves = new PremoveQueue(engine, (color) => this.canPremove(color));

    this.createTimers();
    this.setBotWorker(botWorker);
    this.engine.subscribe((event) => this.handleEngineEvent(event));
    this.updateTimerLabels();
    this.renderMoveList();
  }

  createTimers() {
    const whiteMinutes = 5;
    const whiteIncrementSeconds = 3;
    const blackMinutes = 5;
    const blackIncrementSeconds = 3;
    this.timers[white] = new Timer(whiteMinutes, whiteIncrementSeconds, "whiteTimer");
    this.timers[black] = new Timer(blackMinutes, blackIncrementSeconds, "blackTimer");
    this.timers[white].onTimeOut = () => this.engine.handleTimeOut(white);
    this.timers[black].onTimeOut = () => this.engine.handleTimeOut(black);
    this.timers[white].onTimeWarning = () => this.playLowTimeSound();
    this.timers[black].onTimeWarning = () => this.playLowTimeSound();
  }

  setBotWorker(worker) {
    this.botWorker = worker;
  }

  setBot(color, bot) {
    this.bots[color] = bot;
    const queuedColor = this.premoves.color();
    if (queuedColor !== undefined && !this.canPremove(queuedColor)) this.premoves.clear();
    this.setPlayerName(color, bot ? "CapraStar" : "User");
  }

  hasActiveBots() {
    return this.bots.some((bot) => bot !== undefined);
  }

  canPremove(color) {
    if (this.engine.originalGameConcluded) return false;
    return this.hasActiveBots() && this.bots[color] === undefined;
  }

  isBotTurn() {
    return this.bots[this.engine.clrToMove] !== undefined;
  }

  setPlayerName(color, name) {
    this.playerNames[color] = name || "User";
    this.updateTimerLabels();
  }

  getPlayers() {
    return { whitePlayer: this.playerNames[white], blackPlayer: this.playerNames[black] };
  }

  updateTimerLabels() {
    const whiteLabel = document.getElementById("whiteTimerBox")?.querySelector(".timerLabel");
    const blackLabel = document.getElementById("blackTimerBox")?.querySelector(".timerLabel");
    if (whiteLabel) whiteLabel.textContent = this.playerNames[white];
    if (blackLabel) blackLabel.textContent = this.playerNames[black];
  }

  handleEngineEvent(event) {
    if (event.type === "gameStateChanged" && event.reason === "timeout") this.gameEndedByTimeout = true;
    if (event.type === "restarted" || event.type === "positionLoaded") this.gameEndedByTimeout = false;

    if (event.type === "positionChanged") {
      this.renderMoveList();
      this.onPositionChanged?.();
      return;
    }
    if (event.type === "movePlayed") this.playMoveSound(event);
    if (event.type === "moveUndone") this.playUndoSound(event.move);
    if (event.type === "navigation" && event.soundMove) {
      const isCapture =
        event.soundIsCapture ??
        (Piece.type(Move.capturePiece(event.soundMove, this.engine.board)) !== none || Move.flag(event.soundMove) === enPassantFlag);
      this.playMoveSound({ isCastle: Move.flag(event.soundMove) === castleFlag, isCapture });
    }
    if (event.type === "restarted") {
      this.timers[white]?.reset();
      this.timers[black]?.reset();
      this.updateTimerLabels();
      clearBoardAnnotations();
      this.premoves.clear();
    }
    if (event.type === "positionLoaded" || event.type === "historyNavigationStarted" || event.type === "navigation" || event.type === "moveUndone") {
      this.premoves.clear();
    }
    if (event.type === "gameStateChanged") {
      this.syncGamePresentation(event);
      if (this.engine.result !== GameResult.inProgress && this.engine.result !== GameResult.starting) {
        this.onPositionChanged?.();
      }
    }
  }

  syncGamePresentation(event) {
    const engine = this.engine;
    // This must precede requestBotMove: a premove takes priority as soon as
    // the opponent has supplied the position it was waiting for.
    if (this.premoves.playNext()) return;
    this.manageTimers();
    if (engine.moveGenerator.inCheck) check_Sound.play();

    if (event.reason === "timeout") {
      gameOver_Sound.play();
      return;
    }
    if (engine.result !== GameResult.inProgress && engine.result !== GameResult.starting && engine.gameIsOver) {
      gameOver_Sound.play();
      return;
    }
    this.requestBotMove();
  }

  manageTimers() {
    const engine = this.engine;
    const currentTimer = this.timers[engine.clrToMove];
    const otherTimer = this.timers[engine.clrToMove === white ? black : white];

    // Clocks must stay frozen once the game has concluded, or when viewing historic positions
    if (engine.originalGameConcluded || engine.isUndoingMoves() || engine.result === GameResult.starting) {
      currentTimer?.stop();
      otherTimer?.stop();
      return;
    }
    currentTimer?.start();
    if (engine.result === GameResult.inProgress) {
      currentTimer?.play();
      if (engine.moveHistory.length > 0) otherTimer?.pause();
      return;
    }
    currentTimer?.stop();
    otherTimer?.stop();
  }

  requestBotMove() {
    const engine = this.engine;
    const bot = this.bots[engine.clrToMove];
    if (engine.originalGameConcluded || this.gameEndedByTimeout || engine.result !== GameResult.inProgress || !bot || engine.isUndoingMoves()) return;
    bot.postMessage({
      type: "search",
      fen: engine.board.toFEN(true, true),
      ...this.getSearchTimeControl(engine.clrToMove),
      positionGeneration: engine.positionGeneration,
    });
  }

  getSearchTimeControl(color) {
    const timer = this.timers[color];
    if (!timer?.isUnlimited) {
      return {
        timeRemainingMs: (timer?.remainingTime || 0) * 1000,
        incrementMs: (timer?.increment || 0) * 1000,
      };
    }

    // Unlimited games still need a practical fixed analysis duration.
    return { timeRemainingMs: null, incrementMs: 0, moveTimeMs: 4000 };
  }

  playMoveSound({ isCastle, isCapture }) {
    if (isCastle) castle_Sound.play();
    else if (isCapture) capture_Sound.play();
    else move_Sound.play();
  }

  playInvalidMoveSound() {
    invalidMove_Sound?.play();
  }

  playLowTimeSound() {
    if (this.engine.result !== GameResult.inProgress) return;
    lowTime_Sound?.play();
  }

  playUndoSound(move) {
    const isCapture = Move.flag(move) === enPassantFlag || Piece.type(Move.capturePiece(move, this.engine.board)) !== none;
    this.playMoveSound({ isCastle: Move.flag(move) === castleFlag, isCapture });
  }

  startGame() {
    if (this.engine.result !== GameResult.starting) return;
    start_Sound.play();
    this.engine.startGame();
  }

  renderMoveList() {
    const movesList = document.getElementById("movesList");
    if (!movesList) return;
    const engine = this.engine;
    movesList.replaceChildren();

    const isAnalyzing = engine.isAnalyzing;
    const allMoves = isAnalyzing
      ? [...engine.moveSANHistory, ...engine.analysisRedoSANHistory.slice().reverse()]
      : [...engine.moveSANHistory, ...engine.redoSANHistory.slice().reverse()];
    const activeMoveCount = engine.moveSANHistory.length;
    const analysisBranchPly = isAnalyzing ? engine.analysisBranchPly : Infinity;

    allMoves.forEach((sanMove, index) => {
      let row = movesList.lastElementChild;
      if (index % 2 === 0) {
        row = document.createElement("li");
        row.className = "move-row";
        const number = document.createElement("span");
        number.className = "move-number";
        number.textContent = `${index / 2 + 1}.`;
        row.appendChild(number);
        movesList.appendChild(row);
      }
      const ply = document.createElement("button");
      ply.type = "button";
      ply.className = `move-ply ${index % 2 === 0 ? "white-ply" : "black-ply"}`;
      ply.textContent = sanMove;
      ply.setAttribute("aria-label", `Go to position after move ${index + 1}: ${sanMove}`);
      ply.addEventListener("click", () => engine.goToMove(index + 1));
      if (index >= analysisBranchPly) {
        ply.classList.add("analysis-ply");
      }
      if (index === activeMoveCount - 1) ply.classList.add("last-played-move");
      if (index >= activeMoveCount) ply.classList.add("redo-move");
      row.appendChild(ply);
    });
    movesList.querySelector(".last-played-move")?.scrollIntoView({ block: "nearest" });
    this.updateNavigationButtons();
  }

  updateNavigationButtons() {
    const canUndo = this.engine.moveHistory.length > 0;
    const canRedo = this.engine.isAnalyzing ? this.engine.analysisRedoMoves.length > 0 : this.engine.redoHistory.length > 0;

    document.getElementById("firstPositionBTN").disabled = !canUndo;
    document.getElementById("undoMoveBTN").disabled = !canUndo;
    document.getElementById("redoMoveBTN").disabled = !canRedo;
    document.getElementById("lastPositionBTN").disabled = !canRedo;
  }
}
