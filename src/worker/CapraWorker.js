// Browser worker entry point. CapraStar's browser build uses classic scripts,
// so its dependencies share this worker's global scope.
importScripts(
  `../chess/Perft.js?v=${Date.now()}`,
  `../chess/Constants.js?v=${Date.now()}`,
  `../chess/BoardUtil.js?v=${Date.now()}`,
  `../chess/BBUtil.js?v=${Date.now()}`,
  `../chess/Piece.js?v=${Date.now()}`,
  `../chess/Zobrist.js?v=${Date.now()}`,
  `../chess/GameState.js?v=${Date.now()}`,
  `../chess/Board.js?v=${Date.now()}`,
  `../chess/Move.js?v=${Date.now()}`,
  `../chess/MoveGenerator.js?v=${Date.now()}`,
  `../engine/Evaluator.js?v=${Date.now()}`,
  `../engine/MoveSorter.js?v=${Date.now()}`,
  `../engine/TranspositionTable.js?v=${Date.now()}`,
  `../engine/TimeManager.js?v=${Date.now()}`,
  `../engine/CapraStar.js?v=${Date.now()}`,
);

let capraStar = null;
let pendingSearch = null;
let searchRunning = false;
let pendingEvaluation = null;
let evaluatorRunning = false;

function getSearchLimits(request, legalMoves) {
  return capraStar.timeManager.calculateClockLimits({
    board: capraStar.board,
    evaluator: capraStar.evaluator,
    legalMoves,
    timeRemaining: request.timeRemainingMs,
    increment: request.incrementMs,
    movesToGo: request.movesToGo,
    moveTime: request.moveTimeMs,
  });
}

function createCapraStar(book = {}) {
  const engine = new CapraStar(new Board());
  engine.openingBook = book || {};
  return engine;
}

onmessage = function (e) {
  const { type, fen } = e.data;
  const requestId = e.data.requestId;
  const positionGeneration = e.data.positionGeneration;
  const timeControl = {
    timeRemainingMs: Number.isFinite(e.data.timeRemainingMs) ? e.data.timeRemainingMs : null,
    incrementMs: Number.isFinite(e.data.incrementMs) ? e.data.incrementMs : 0,
    movesToGo: Number.isFinite(e.data.movesToGo) ? e.data.movesToGo : null,
    moveTimeMs: Number.isFinite(e.data.moveTimeMs) ? e.data.moveTimeMs : null,
  };

  switch (type) {
    case "init":
      capraStar = createCapraStar(e.data.book);
      break;
    case "search":
      if (!capraStar) capraStar = createCapraStar();
      pendingSearch = {
        fen,
        requestId,
        positionGeneration,
        yieldEveryNodes: e.data.yieldEveryNodes,
        ...timeControl,
      };
      capraStar.cancelSearch();
      processSearchQueue();
      break;
    case "evaluate":
      if (!capraStar) capraStar = createCapraStar();
      postMessage({
        type: "log",
        msg: `Evaluator received request ${requestId} for position generation ${positionGeneration}.`,
      });
      pendingEvaluation = {
        fen,
        requestId,
        positionGeneration,
        yieldEveryNodes: e.data.yieldEveryNodes,
        ...timeControl,
      };
      capraStar.cancelSearch();
      processEvaluationQueue();
      break;
  }
};

async function processSearchQueue() {
  if (searchRunning) return;
  searchRunning = true;

  try {
    while (pendingSearch) {
      const request = pendingSearch;
      pendingSearch = null;
      capraStar.board.init();
      capraStar.board.fillBoard(request.fen);

      const legalMoves = capraStar.moveGen.generateMoves(capraStar.board);
      const timeLimits = getSearchLimits(request, legalMoves);
      const start = performance.now();
      await capraStar.getBestMove(legalMoves, timeLimits, null, Infinity, request.yieldEveryNodes);

      if (pendingSearch) continue;
      if (capraStar.isBookMove) {
        // Keep opening-book moves readable as deliberate moves rather than
        // playing them instantly. The wait also remains cancellable because
        // incoming searches can replace this pending result.
        const bookMoveDelayMs = 100 + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, bookMoveDelayMs));
        if (pendingSearch) continue;
      }
      postMessage({
        type: "result",
        bestMove: capraStar.bestMoveFound,
        evaluation: capraStar.evaluation,
        depth: capraStar.maxDepthReached ?? 0,
        requestId: request.requestId,
        positionGeneration: request.positionGeneration,
        timeTaken: performance.now() - start,
        isBookMove: capraStar.isBookMove,
        pv: capraStar.principalVariation,
      });
    }
  } finally {
    searchRunning = false;
    if (pendingSearch) processSearchQueue();
  }
}

async function processEvaluationQueue() {
  if (evaluatorRunning) return;
  evaluatorRunning = true;

  try {
    while (pendingEvaluation) {
      const request = pendingEvaluation;

      pendingEvaluation = null;
      capraStar.board.init();
      capraStar.board.fillBoard(request.fen);
      const moves = capraStar.moveGen.generateMoves(capraStar.board);
      const timeLimits = getSearchLimits(request, moves);

      const start = performance.now();

      await capraStar.getBestMove(
        moves,
        timeLimits,
        (depthInfo) => {
          postMessage({
            type: "evaluation",
            bestMove: depthInfo.bestMove,
            evaluation: depthInfo.score,
            pv: depthInfo.pv,
            timeTaken: performance.now() - start,
            depth: depthInfo.depth,
            nodesSearched: depthInfo.nodesSearched,
            requestId: request.requestId,
            positionGeneration: request.positionGeneration,
            fen: request.fen,
            isBookMove: capraStar.isBookMove,
          });
        },
        Infinity,
        request.yieldEveryNodes,
      );
    }
  } finally {
    evaluatorRunning = false;
    if (pendingEvaluation) processEvaluationQueue();
  }
}
