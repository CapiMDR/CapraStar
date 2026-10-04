import { Board } from "../Board.js";
import { CapraStar } from "./CapraStar.js";
import { Move } from "../Move.js";
import { loadBookMoveEntries } from "../OpeningBook.js";
import { white } from "../Constants.js";
// uci.js
//
// Node.js UCI interface for CapraStar.
// Launch with:
//   node uci.js
//

("use strict");

import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bookPath = path.join(__dirname, "../Book.txt");

// ------------------------------------------------------------
// Engine state
// ------------------------------------------------------------

let capraStar = null;
let searchPromise = null;
let searchRunning = false;
let stopRequested = false;

let currentPositionGeneration = 0;

// UCI options
let hashSizeMb = 64;

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
  process.stderr.write(message);
}

// ------------------------------------------------------------
// Engine initialization
// ------------------------------------------------------------

function ensureEngine() {
  if (!capraStar) {
    capraStar = new CapraStar(new Board());
  }

  return capraStar;
}

// ------------------------------------------------------------
// UCI: position
// ------------------------------------------------------------

function setPosition(args) {
  const engine = ensureEngine();

  let fen;
  let moves = [];

  const tokens = args.trim().split(/\s+/);

  if (tokens[0] === "startpos") {
    fen = "startpos";

    const movesIndex = tokens.indexOf("moves");

    if (movesIndex !== -1) {
      moves = tokens.slice(movesIndex + 1);
    }
  } else if (tokens[0] === "fen") {
    const movesIndex = tokens.indexOf("moves");

    if (movesIndex === -1) {
      // FEN consists of six fields.
      fen = tokens.slice(1, 7).join(" ");
    } else {
      fen = tokens.slice(1, movesIndex).join(" ");
      moves = tokens.slice(movesIndex + 1);
    }
  } else {
    return;
  }

  currentPositionGeneration++;

  engine.board.init();

  if (fen === "startpos") {
    engine.board.fillBoard("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  } else {
    engine.board.fillBoard(fen);
  }
  engine.positionHistory = [];

  for (const uciMove of moves) {
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

// ------------------------------------------------------------
// ADAPT THESE TWO FUNCTIONS TO YOUR ENGINE
// ------------------------------------------------------------

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

async function go(args) {
  if (searchRunning) {
    return;
  }

  const engine = ensureEngine();

  stopRequested = false;
  searchRunning = true;

  const tokens = args.trim().split(/\s+/);

  let wtime = null;
  let btime = null;
  let winc = 0;
  let binc = 0;

  let movetime = null;
  let depth = null;
  let nodes = null;

  let infinite = false;

  for (let i = 0; i < tokens.length; i++) {
    switch (tokens[i]) {
      case "wtime":
        wtime = Number(tokens[++i]);
        break;

      case "btime":
        btime = Number(tokens[++i]);
        break;

      case "winc":
        winc = Number(tokens[++i]);
        break;

      case "binc":
        binc = Number(tokens[++i]);
        break;

      case "movetime":
        movetime = Number(tokens[++i]);
        break;

      case "depth":
        depth = Number(tokens[++i]);
        break;

      case "nodes":
        nodes = Number(tokens[++i]);
        break;

      case "infinite":
        infinite = true;
        break;
    }
  }

  // ----------------------------------------------------------
  // Determine which clock applies.
  // ----------------------------------------------------------

  const sideToMove = engine.board.clrToMove;

  const timeRemaining = sideToMove === white ? wtime : btime;

  const increment = sideToMove === white ? winc : binc;

  // ----------------------------------------------------------
  // Calculate search time.
  // ----------------------------------------------------------

  let timeBudgetMs;

  if (movetime !== null && Number.isFinite(movetime)) {
    timeBudgetMs = Math.max(1, movetime);
  } else if (timeRemaining !== null && Number.isFinite(timeRemaining)) {
    // Time management
    //timeBudgetMs = Math.min(Math.max(50, timeRemaining * 0.08 + increment * 0.5), Math.max(50, timeRemaining - 50));
    timeBudgetMs = timeRemaining * 0.05 + increment * 0.5;
  } else if (infinite || Number.isFinite(nodes)) {
    timeBudgetMs = 24 * 60 * 60 * 1000;
  } else {
    // Reasonable default if no clock was supplied.
    timeBudgetMs = 1000;
  }

  // ----------------------------------------------------------
  // Generate legal moves.
  // ----------------------------------------------------------

  const legalMoves = engine.moveGen.generateMoves(engine.board);

  if (!legalMoves || legalMoves.length === 0) {
    searchRunning = false;

    // There is no legal move.
    uciPrint("bestmove 0000");
    return;
  }

  const generation = currentPositionGeneration;

  try {
    // Don't return a promise after each completed depth, fastchess expects one response only
    await engine.getBestMove(legalMoves, timeBudgetMs, null, nodes);

    if (stopRequested) return;

    let line = "info";

    if (engine.maxDepthReached) {
      line += ` depth ${engine.maxDepthReached}`;
    }

    if (engine.evaluation != null) {
      line += ` score ${scoreToUCI(engine.evaluation)}`;
    }

    if (engine.principalVariation) {
      const pv = Array.isArray(engine.principalVariation) ? engine.principalVariation.map(moveToUCI).join(" ") : String(engine.principalVariation);

      if (pv) {
        line += ` pv ${pv}`;
      }
    }

    //uciPrint(line);

    // Don't return a result for an obsolete position.
    if (generation !== currentPositionGeneration) return;

    let bestMove = engine.bestMoveFound;

    if (!bestMove) {
      uciPrint("bestmove 0000");
      return;
    }

    if (typeof bestMove !== "string") {
      bestMove = moveToUCI(bestMove);
    }

    uciPrint(`bestmove ${bestMove}`);
  } catch (err) {
    debug(err.stack || err);
    uciPrint(err.stack);
    // Fastchess expects the engine to remain alive.
    uciPrint("bestmove 0000");
  } finally {
    searchPromise = null;
    searchRunning = false;
  }
}

// ------------------------------------------------------------
// UCI: stop
// ------------------------------------------------------------

function stop() {
  stopRequested = true;

  if (capraStar) {
    capraStar.cancelSearch();
  }
}

function isReady() {
  uciPrint("readyok");
}

function uci() {
  uciPrint("id name CapraStar");
  uciPrint("id author CapiMDR");

  // Add options here if your engine supports them.
  uciPrint(`option name Hash type spin default ${hashSizeMb} min 1 max 4096`);

  uciPrint("option name isolatedPawnPenalty type spin default 15 min 0 max 50");
  uciPrint("option name defendedPawnBonus type spin default 5 min 0 max 30");
  uciPrint("option name doubledPawnsPenalty type spin default 20 min 0 max 60");
  uciPrint("option name kingShieldBonus type spin default 5 min 0 max 20");
  uciPrint("option name myTurnBonus type spin default 10 min 0 max 40");
  uciPrint("option name bishopPairBonus type spin default 30 min 0 max 80");
  uciPrint("option name kingMobilityPenalty type spin default 1 min 0 max 20");
  uciPrint("option name rookOpenFileBonus type spin default 30 min 0 max 80");
  uciPrint("option name connectedRooksBonus type spin default 20 min 0 max 60");
  uciPrint("option name blockedPawnPenalty type spin default 15 min 0 max 50");
  uciPrint("option name openFileNearKingPenalty type spin default 5 min 0 max 40");
  uciPrint("option name mobilityWeight type spin default 2 min 0 max 15"); // Inactive
  uciPrint("option name outpostBonus type spin default 10 min 0 max 50");

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
    myturnbonus: ["myTurnBonus", 0, 40],
    bishoppairbonus: ["bishopPairBonus", 0, 80],
    kingmobilitypenalty: ["kingMobilityPenalty", 0, 20],
    rookopenfilebonus: ["rookOpenFileBonus", 0, 80],
    connectedrooksbonus: ["connectedRooksBonus", 0, 60],
    blockedpawnpenalty: ["blockedPawnPenalty", 0, 50],
    openfilenearkingpenalty: ["openFileNearKingPenalty", 0, 40],
    mobilityweight: ["mobilityWeight", 0, 15],
    outpostbonus: ["outpostBonus", 0, 50],
  }[name.toLowerCase()];
  if (!option) return;

  const parsedValue = Number(value);

  if (Number.isFinite(parsedValue)) {
    const [property, min, max] = option;

    const clampedValue = Math.max(min, Math.min(max, parsedValue));

    ensureEngine().params[property] = clampedValue;

    console.error(`SETOPTION ${property} = ${clampedValue}`);
  }
}

// Evaluation in centipawns
function scoreToUCI(score) {
  if (!Number.isFinite(score)) {
    return "cp 0";
  }

  return `cp ${Math.round(score)}`;
}

// ------------------------------------------------------------
// UCI command parser
// ------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  line = line.trim();

  if (!line) return;

  const space = line.indexOf(" ");

  const command = space === -1 ? line : line.slice(0, space);

  const args = space === -1 ? "" : line.slice(space + 1);

  switch (command) {
    case "uci":
      uci();
      break;

    case "isready":
      isReady();
      break;

    case "ucinewgame":
      stop();
      const book = loadBookMoveEntries(fs.readFileSync(bookPath, "utf-8"));
      capraStar = new CapraStar(new Board());
      capraStar.openingBook = book;
      currentPositionGeneration++;

      break;

    case "setoption":
      setOption(args);
      break;

    case "position":
      stop();

      try {
        setPosition(args);
      } catch (err) {
        debug(err.stack || err);
      }

      break;

    case "go":
      go(args);
      break;

    case "stop":
      stop();
      break;

    case "quit":
      stop();

      setTimeout(() => {
        process.exit(0);
      }, 10);

      break;

    case "ponderhit":
      // Not implementing pondering yet.
      break;

    case "debug":
      // UCI debug command.
      break;

    default:
      // UCI allows unknown commands to be ignored.
      break;
  }
});
