import { Move } from "../Chess_Components/Move.js";

// Owns the engine's search-clock lifecycle:
//
// 1. UCI converts its active side's clock into a soft/hard budget here.
// 2. CapraStar starts a search with that budget, creating absolute deadlines.
// 3. Search checks the hard deadline at every node; completed iterations also
//    stop at the soft deadline, preserving time to report `bestmove`.
// 4. A ponder search has no deadline until UCI calls setSearchTimeLimit() on
//    ponderhit, at which point this class starts the saved budget from then.
export class TimeManager {
  constructor(mateScore) {
    this.mateScore = mateScore;
    this.searchDeadline = Infinity;
    this.searchSoftDeadline = Infinity;
    this.state = null;
  }

  startSearch(timeLimitMs, legalMoves, board) {
    const limits = typeof timeLimitMs === "object" && timeLimitMs !== null ? timeLimitMs : null;
    const hardLimitMs = limits ? limits.hardLimitMs : timeLimitMs;
    const softLimitMs = limits ? limits.softLimitMs : hardLimitMs;
    const now = performance.now();
    this.setDeadlines(now, softLimitMs, hardLimitMs);

    // Numeric budgets (the no-clock fallback) also receive a soft boundary.
    // Infinity deliberately leaves state null for pondering and infinite search.
    this.state =
      Number.isFinite(softLimitMs) && Number.isFinite(hardLimitMs)
        ? this.createState(
            now,
            softLimitMs,
            hardLimitMs,
            Array.isArray(legalMoves) ? legalMoves.length : 0,
            limits && Number.isFinite(limits.rootComplexity) ? limits.rootComplexity : this.estimateRootComplexity(legalMoves, board),
          )
        : null;
  }

  setSearchTimeLimit(timeLimitMs) {
    const limits = typeof timeLimitMs === "object" && timeLimitMs !== null ? timeLimitMs : null;
    const hardLimitMs = limits ? limits.hardLimitMs : timeLimitMs;
    const softLimitMs = limits ? limits.softLimitMs : hardLimitMs;
    const now = performance.now();
    this.setDeadlines(now, softLimitMs, hardLimitMs);
    this.state =
      Number.isFinite(softLimitMs) && Number.isFinite(hardLimitMs)
        ? this.createState(
            now,
            softLimitMs,
            hardLimitMs,
            this.state?.legalMovesCount || 30,
            Number.isFinite(limits?.rootComplexity) ? limits.rootComplexity : 50,
          )
        : null;
  }

  setDeadlines(now, softLimitMs, hardLimitMs) {
    this.searchDeadline = Number.isFinite(hardLimitMs) ? now + Math.max(1, hardLimitMs) : Infinity;
    this.searchSoftDeadline = Number.isFinite(softLimitMs) ? now + Math.max(1, Math.min(softLimitMs, hardLimitMs)) : Infinity;
  }

  createState(searchStart, softLimitMs, hardLimitMs, legalMovesCount, rootComplexity) {
    return { searchStart, softLimitMs, hardLimitMs, legalMovesCount, rootComplexity };
  }

  estimateRootComplexity(legalMoves, board) {
    if (!legalMoves || legalMoves.length === 0) return 0;
    let tacticalMoves = 0;
    for (const move of legalMoves) if (Move.isCapture(move, board) || Move.isPromotion(move)) tacticalMoves++;
    const movePressure = Math.min(30, legalMoves.length) * 1.15;
    const tacticalPressure = (tacticalMoves / legalMoves.length) * 30;
    const checkPressure = board.inCheck() ? 18 : 0;
    return Math.max(5, Math.min(95, 12 + movePressure + tacticalPressure + checkPressure));
  }

  // Converts UCI clock data into the soft/hard limits consumed by search.
  // `softLimitMs` is the normal search allocation; `hardLimitMs` is only a
  // fail-safe for a single unexpectedly expensive iteration. Both leave time
  // for UCI output and event-loop latency.
  calculateClockLimits({ board, evaluator, legalMoves, timeRemaining, increment, movesToGo, moveTime }) {
    // `movetime` is an exact per-move budget, but reserve at least 10 ms and
    // up to 50 ms for cancellation, formatting, and printing bestmove.
    if (moveTime !== null && Number.isFinite(moveTime)) {
      const outputReserveMs = Math.min(50, Math.max(10, moveTime * 0.1));
      const hardLimitMs = Math.max(1, moveTime - outputReserveMs);
      return { softLimitMs: hardLimitMs * 0.75, hardLimitMs, dynamic: true };
    }

    if (timeRemaining === null || !Number.isFinite(timeRemaining)) return null;

    const remaining = Math.max(0, timeRemaining);
    // This reserve is outside the search deadline. It absorbs UCI parsing,
    // legal-move generation, bestmove output, and scheduler jitter.
    const reserveMs = Math.min(500, Math.max(50, remaining * 0.05));
    const usableMs = Math.max(1, remaining - reserveMs);
    const phase = evaluator.calcGamePhase(board);
    const estimatedMovesToGo = Number.isFinite(movesToGo) && movesToGo > 0 ? movesToGo : phase >= 16 ? 24 : phase >= 8 ? 18 : 12;
    const baseMs = usableMs / estimatedMovesToGo + Math.max(0, increment) * 0.7;
    const rootComplexity = this.estimateRootComplexity(legalMoves, board);
    const softMultiplier = 0.7 + rootComplexity * 0.006;
    const softLimitMs = Math.max(5, baseMs * softMultiplier);

    // Hard time is deliberately close to normal time. We do not borrow a
    // large fraction of the remaining clock merely because a position looks
    // tactical; the next move still needs time.
    const hardLimitMs = Math.min(usableMs, Math.max(baseMs * 1.8, softLimitMs * 1.5));

    return { softLimitMs: Math.min(softLimitMs, hardLimitMs * 0.8), hardLimitMs, rootComplexity, dynamic: true };
  }

  shouldStopAfterCompletedDepth(score, iterationMs) {
    const manager = this.state;
    if (!manager) return false;
    if (manager.legalMovesCount <= 1 || (Math.abs(score) > this.mateScore - 1000 && score > 0)) return true;

    const now = performance.now();
    const predictedNextIterationMs = Math.max(5, iterationMs * 2.5);
    // The soft deadline is a true iteration boundary. A completed iteration
    // is always a safe point to keep its PV and return it to the GUI.
    if (now >= this.searchSoftDeadline) return true;
    if (now + predictedNextIterationMs >= this.searchDeadline) return true;
    return false;
  }
}
