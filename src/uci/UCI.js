import { loadCapraRuntime } from "./loadNodeRuntime.js";

// The engine and its chess dependencies are environment-neutral classic
// scripts. Node loads them once through this adapter; the browser worker uses
// importScripts for the same files.
const { Board, CapraStar, Move, loadBookMoveEntries, white } = loadCapraRuntime();
// uci.js
//
// Node.js UCI interface for CapraStar.
// Launch with:
//   node uci.js
//

("use strict");

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bookPath = path.join(__dirname, "../../public/data/Book.txt");
let debugging = false;

// ------------------------------------------------------------
// Engine state
// ------------------------------------------------------------

let capraStar = null;
let searchRunning = false;
let stopRequested = false;
let suppressBestMove = false;
let pondering = false;
let ponderTimeBudgetMs = null;
let releaseCompletedPonder = null;

let currentPositionGeneration = 0;

// UCI options
let hashSizeMb = 64;
// UCI options must survive ucinewgame, which creates a fresh CapraStar.
const evaluationOptions = {};

// ------------------------------------------------------------
// UCI output
// IMPORTANT: stdout is reserved for UCI.
// Do not console.log debugging information to stdout.
// Use console.error() for debugging.
// ------------------------------------------------------------

function uciPrint(message) {
  process.stdout.write(message + "\n");
}

function debug(message) {
  // Uncomment when debugging.
  if (!debugging) return;
  console.error("[CapraStar DEBUG] " + message);
}

// ------------------------------------------------------------
// Engine initialization
// ------------------------------------------------------------

function ensureEngine() {
  if (!capraStar) {
    capraStar = new CapraStar(new Board());
    Object.assign(capraStar.params, evaluationOptions);
  }

  return capraStar;
}

// ------------------------------------------------------------
// UCI: position
// ------------------------------------------------------------

function parsePositionArguments(args) {
  const tokens = args.trim().split(/\s+/);
  if (tokens[0] === "startpos") {
    const movesIndex = tokens.indexOf("moves");
    return { fen: "startpos", moves: movesIndex === -1 ? [] : tokens.slice(movesIndex + 1) };
  } else if (tokens[0] === "fen") {
    const movesIndex = tokens.indexOf("moves");
    return {
      fen: movesIndex === -1 ? tokens.slice(1, 7).join(" ") : tokens.slice(1, movesIndex).join(" "),
      moves: movesIndex === -1 ? [] : tokens.slice(movesIndex + 1),
    };
  }
  return null;
}

function loadPosition(board, fen) {
  board.init();
  board.fillBoard(fen === "startpos" ? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" : fen);
}

function setPosition(args) {
  const position = parsePositionArguments(args);
  if (!position) return;

  const engine = ensureEngine();

  currentPositionGeneration++;
  loadPosition(engine.board, position.fen);
  engine.positionHistory = [];

  for (const uciMove of position.moves) {
    applyUCIMove(engine, uciMove);
  }
}

// ------------------------------------------------------------
// Apply a UCI move to the engine's board
// ------------------------------------------------------------

function applyUCIMove(engine, uciMove) {
  /*
   *   1. Generate legal moves.
   *   2. Convert each legal move to UCI notation.
   *   3. Find the matching move.
   *   4. Make that move.
   */

  const legalMoves = engine.moveGen.generateMoves(engine.board);

  for (const move of legalMoves) {
    const candidate = Move.toString(move);

    if (candidate === uciMove) {
      makeMove(engine, move);
      return;
    }
  }

  debug("Could not find legal move: " + uciMove);
  throw new Error(`Illegal/unrecognized UCI move "${uciMove}"`);
}
function moveToUCI(move) {
  return Move.toString(move);
}

function makeMove(engine, move) {
  if (typeof engine.board.makeMove === "function") {
    engine.board.makeMove(move);
    return;
  }

  throw new Error("Could not play a move " + move);
}

// ------------------------------------------------------------
// UCI: go
// ------------------------------------------------------------

function parseGoArguments(args) {
  const options = {
    wtime: null,
    btime: null,
    winc: 0,
    binc: 0,
    movetime: null,
    depth: null,
    nodes: null,
    movestogo: null,
    infinite: false,
    ponder: false,
  };
  const numericOptions = new Set(["wtime", "btime", "winc", "binc", "movetime", "depth", "nodes", "movestogo"]);
  const tokens = args.trim().split(/\s+/);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "infinite" || token === "ponder") options[token] = true;
    if (numericOptions.has(token)) options[token] = Number(tokens[++index]);
  }
  return options;
}

function selectClockForSide(engine, goOptions) {
  const whiteToMove = engine.board.clrToMove === white;
  return { timeRemaining: whiteToMove ? goOptions.wtime : goOptions.btime, increment: whiteToMove ? goOptions.winc : goOptions.binc };
}

function resolveSearchBudget(engine, legalMoves, goOptions) {
  const { timeRemaining, increment } = selectClockForSide(engine, goOptions);
  const clockBudget = engine.timeManager.calculateClockLimits({
    board: engine.board,
    evaluator: engine.evaluator,
    legalMoves,
    timeRemaining,
    increment,
    movesToGo: goOptions.movestogo,
    moveTime: goOptions.movetime,
  });
  if (clockBudget !== null) return clockBudget;
  return goOptions.infinite || Number.isFinite(goOptions.nodes) ? 24 * 60 * 60 * 1000 : 1000;
}

function formatSearchInfo(engine) {
  let line = "info";
  if (engine.maxDepthReached) line += ` depth ${engine.maxDepthReached}`;
  if (engine.evaluation != null) line += ` score ${scoreToUCI(engine.evaluation)}`;
  const pv = Array.isArray(engine.principalVariation) ? engine.principalVariation.map(moveToUCI).join(" ") : String(engine.principalVariation || "");
  if (pv) line += ` pv ${pv}`;
  return line;
}

function emitBestMove(engine) {
  if (!engine.bestMoveFound) return uciPrint("bestmove 0000");
  const bestMove = typeof engine.bestMoveFound === "string" ? engine.bestMoveFound : moveToUCI(engine.bestMoveFound);
  const pvReply = Array.isArray(engine.principalVariation) && engine.principalVariation.length > 1 ? engine.principalVariation[1] : null;
  const ponderMove = pvReply === null || typeof pvReply === "string" ? pvReply : moveToUCI(pvReply);
  uciPrint(`bestmove ${bestMove}${ponderMove ? ` ponder ${ponderMove}` : ""}`);
}

async function go(args) {
  if (searchRunning) return;

  const engine = ensureEngine();
  const goOptions = parseGoArguments(args);
  stopRequested = false;
  suppressBestMove = false;
  searchRunning = true;
  pondering = goOptions.ponder;
  if (pondering) debug("=== PONDER STARTED ===");

  try {
    const legalMoves = engine.moveGen.generateMoves(engine.board);
    if (!legalMoves?.length) {
      uciPrint("bestmove 0000");
      return;
    }

    const timeBudgetMs = resolveSearchBudget(engine, legalMoves, goOptions);
    debug(`=== TIME BUDGET: ${typeof timeBudgetMs === "object" ? JSON.stringify(timeBudgetMs) : timeBudgetMs} ===`);
    ponderTimeBudgetMs = timeBudgetMs;
    const generation = currentPositionGeneration;

    await engine.getBestMove(legalMoves, pondering ? Infinity : timeBudgetMs, null, goOptions.nodes);
    await waitForPonderHit();
    if (stopRequested && suppressBestMove) return;

    uciPrint(formatSearchInfo(engine));
    if (generation === currentPositionGeneration) emitBestMove(engine);
  } catch (err) {
    debug(err.stack || err);
    uciPrint("bestmove 0000");
  } finally {
    searchRunning = false;
    pondering = false;
    ponderTimeBudgetMs = null;
    releaseCompletedPonder = null;
  }
}
// UCI: stop
// ------------------------------------------------------------

function stop(suppressResult = false) {
  stopRequested = true;
  suppressBestMove = suppressResult;

  if (capraStar) capraStar.cancelSearch();

  if (releaseCompletedPonder) {
    releaseCompletedPonder();
    releaseCompletedPonder = null;
  }
}

async function waitForPonderHit() {
  if (!pondering || stopRequested) return;
  await new Promise((resolve) => {
    releaseCompletedPonder = resolve;
  });
}

function ponderHit() {
  if (!searchRunning || !pondering) return;

  pondering = false;

  if (capraStar) capraStar.setSearchTimeLimit(ponderTimeBudgetMs);

  if (releaseCompletedPonder) {
    releaseCompletedPonder();
    releaseCompletedPonder = null;
  }
}

function isReady() {
  uciPrint("readyok");
}

function uci() {
  uciPrint("id name CapraStar");
  uciPrint("id author CapiMDR");

  // UCI spin options are integers. Evaluation values are declared as strings
  // so clients may send fractional SPSA values; setOption still validates and
  // clamps them to each parameter's intended range.
  const evaluationOption = (name, defaultValue) => uciPrint("option name " + name + " type string default " + defaultValue);
  uciPrint(`option name Hash type spin default ${hashSizeMb} min 1 max 4096`);
  uciPrint("option name Ponder type check default true");

  evaluationOption("isolatedPawnPenalty", 15);
  evaluationOption("defendedPawnBonus", 5);
  evaluationOption("doubledPawnsPenalty", 20);
  evaluationOption("kingShieldBonus", 5);
  evaluationOption("protectedPassedPawnBonus", 12);
  evaluationOption("semiOpenKingPenalty", 10);
  evaluationOption("kingZoneMultiAttackerPenalty", 8);
  evaluationOption("myTurnBonus", 10);
  evaluationOption("bishopPairBonus", 30);
  evaluationOption("kingMobilityPenalty", 1);
  evaluationOption("rookOpenFileBonus", 30);
  evaluationOption("connectedRooksBonus", 20);
  evaluationOption("blockedPawnPenalty", 15);
  evaluationOption("backwardPawnPenalty", 12);
  evaluationOption("connectedPassedPawnBonus", 18);
  evaluationOption("passedPawnEndgameScale", 0.6);
  evaluationOption("openFileNearKingPenalty", 5);
  evaluationOption("outpostBonus", 10);

  uciPrint("uciok");
}

// ------------------------------------------------------------
// UCI: setoption
// ------------------------------------------------------------

function setOption(args) {
  const match = args.match(/^name\s+(.+?)(?:\s+value\s+(.+))?$/i);

  if (!match) return;

  const name = match[1].trim();
  const value = match[2]?.trim();

  // TT Szie parameter
  if (name.toLowerCase() === "hash") {
    const hash = Number(value);

    if (Number.isFinite(hash)) {
      hashSizeMb = Math.max(1, Math.min(4096, Math.floor(hash)));
      // No TT resize method atm
    }
    return;
  }

  // Evaluation parameters
  const option = {
    isolatedpawnpenalty: ["isolatedPawnPenalty", 0, 50],
    defendedpawnbonus: ["defendedPawnBonus", 0, 30],
    doubledpawnspenalty: ["doubledPawnsPenalty", 0, 60],
    kingshieldbonus: ["kingShieldBonus", 0, 20],
    protectedpassedpawnbonus: ["protectedPassedPawnBonus", 0, 20],
    semiopenkingpenalty: ["semiOpenKingPenalty", 0, 20],
    kingzonemultiattackerpenalty: ["kingZoneMultiAttackerPenalty", 0, 30],
    myturnbonus: ["myTurnBonus", 0, 40],
    bishoppairbonus: ["bishopPairBonus", 0, 80],
    kingmobilitypenalty: ["kingMobilityPenalty", 0, 20],
    rookopenfilebonus: ["rookOpenFileBonus", 0, 80],
    connectedrooksbonus: ["connectedRooksBonus", 0, 60],
    blockedpawnpenalty: ["blockedPawnPenalty", 0, 50],
    backwardpawnpenalty: ["backwardPawnPenalty", 0, 50],
    connectedpassedpawnbonus: ["connectedPassedPawnBonus", 0, 80],
    passedpawnendgamescale: ["passedPawnEndgameScale", 0, 2],
    openfilenearkingpenalty: ["openFileNearKingPenalty", 0, 40],
    outpostbonus: ["outpostBonus", 0, 50],
  }[name.toLowerCase()];
  if (!option) return;

  const parsedValue = Number(value);

  if (Number.isFinite(parsedValue)) {
    const [property, min, max] = option;

    const clampedValue = Math.max(min, Math.min(max, parsedValue));

    evaluationOptions[property] = clampedValue;
    ensureEngine().params[property] = clampedValue;

    debug(`SETOPTION ${property} = ${clampedValue}`);
  }
}

// Evaluation in centipawns, return mate result if applicable.
function scoreToUCI(score) {
  if (!Number.isFinite(score)) return "cp 0";
  const mateScore = capraStar.mateScore;
  if (Math.abs(score) > mateScore - 1000) {
    const mateIn = Math.ceil((mateScore - Math.abs(score)) / 2);
    return `mate ${score > 0 ? mateIn : -mateIn}`;
  }
  return `cp ${Math.round(score)}`;
}

function createNewGame() {
  stop(true);
  const book = loadBookMoveEntries(fs.readFileSync(bookPath, "utf-8"));
  capraStar = new CapraStar(new Board());
  Object.assign(capraStar.params, evaluationOptions);
  capraStar.openingBook = book;
  currentPositionGeneration++;
  debug("=== NEW GAME ===");
}

function handlePosition(args) {
  stop(true);
  try {
    setPosition(args);
  } catch (err) {
    debug(err.stack || err);
  }
}

function parseCommandLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(" ");
  return separator === -1 ? { command: trimmed, args: "" } : { command: trimmed.slice(0, separator), args: trimmed.slice(separator + 1) };
}

function handleCommand(command, args) {
  switch (command) {
    case "uci":
      uci();
      debug("=== BOT STARTED ===");
      break;
    case "isready":
      isReady();
      break;
    case "ucinewgame":
      createNewGame();
      break;
    case "setoption":
      setOption(args);
      break;
    case "position":
      handlePosition(args);
      break;
    case "go":
      go(args);
      break;
    case "stop":
      stop();
      debug("=== SEARCH STOPPED ===");
      break;
    case "ponderhit":
      ponderHit();
      debug("=== PONDER HIT ===");
      break;
    case "debug":
      debugging = true;
      break;
    case "quit":
      stop();
      setTimeout(() => process.exit(0), 10);
      break;
    default:
      // UCI allows unknown commands to be ignored.
      break;
  }
}

// ------------------------------------------------------------
// UCI command parser
// ------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const parsed = parseCommandLine(line);
  if (parsed) handleCommand(parsed.command, parsed.args);
});
