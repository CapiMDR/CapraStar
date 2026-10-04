import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

let runtime;

// Loads the same environment-neutral engine source used by the browser
// worker. Keep Node APIs in this adapter, never in src/engine/*.js.
export function loadCapraRuntime() {
  if (runtime) return runtime;

  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectDirectory = path.resolve(runtimeDirectory, "../..");
  const sourceFiles = [
    // Constants initializes its deterministic random generator from Perft.
    // Perft only references the chess classes inside function bodies, so it
    // is safeâ€”and requiredâ€”to evaluate it before Constants.
    "src/chess/Perft.js",
    "src/chess/Constants.js",
    "src/chess/BoardUtil.js",
    "src/chess/Piece.js",
    "src/chess/BBUtil.js",
    "src/chess/Zobrist.js",
    "src/chess/GameState.js",
    "src/chess/Board.js",
    "src/chess/Move.js",
    "src/chess/MoveGenerator.js",
    "src/chess/OpeningBook.js",
    "src/engine/Evaluator.js",
    "src/engine/MoveSorter.js",
    "src/engine/TranspositionTable.js",
    "src/engine/TimeManager.js",
    "src/engine/CapraStar.js",
  ];

  for (const relativePath of sourceFiles) {
    const filename = path.join(projectDirectory, relativePath);
    vm.runInThisContext(fs.readFileSync(filename, "utf8"), { filename });
  }

  runtime = vm.runInThisContext(
    "({ Board, CapraStar, Move, loadBookMoveEntries, white })",
    { filename: path.join(runtimeDirectory, "runtime-exports.js") },
  );
  return runtime;
}
