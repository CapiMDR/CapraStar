// Fixed-size, direct-mapped transposition table with generation-aware replacement.
export class TranspositionTable {
  constructor(size = 1 << 17, mateScore = 10000000) {
    this.size = size;
    this.mask = BigInt(size - 1);
    this.mateScore = mateScore;
    this.generation = 0;
    this.entries = new Array(size);
  }

  beginSearch() {
    this.generation++;
  }

  getKey(board) {
    // Zobrist represents the pieces and rights, while the halfmove clock
    // matters near a fifty-move draw.
    return `${board.zobristKey}:${board.plyCounter}`;
  }

  getIndex(board) {
    return Number(board.zobristKey & this.mask);
  }

  probe(board, key, ply = 0) {
    const entry = this.entries[this.getIndex(board)];
    if (!entry || entry.key !== key) return null;
    entry.generation = this.generation;
    return { ...entry, bestScore: this.adjustMateScoreForRetrieval(entry.bestScore, ply) };
  }

  store(board, key, entry, ply = 0) {
    const index = this.getIndex(board);
    const previous = this.entries[index];
    const storedEntry = {
      ...entry,
      key,
      generation: this.generation,
      bestScore: this.adjustMateScoreForStorage(entry.bestScore, ply),
    };

    if (!previous || previous.key === key) {
      if (
        !previous ||
        storedEntry.depth > previous.depth ||
        (storedEntry.depth === previous.depth && storedEntry.flag === "EXACT" && previous.flag !== "EXACT")
      ) {
        this.entries[index] = storedEntry;
      } else {
        previous.generation = this.generation;
      }
      return;
    }

    const incomingPriority = storedEntry.depth * 4 + this.generation;
    const previousPriority = previous.depth * 4 + previous.generation;
    if (incomingPriority >= previousPriority) this.entries[index] = storedEntry;
  }

  isMateScore(score) {
    return Math.abs(score) > this.mateScore - 1000;
  }

  // Adjust mate scores to account for the number of plies to mate, so that the engine prefers faster mates.
  adjustMateScoreForStorage(score, ply) {
    if (!this.isMateScore(score)) return score;
    return score > 0 ? score + ply : score - ply;
  }

  adjustMateScoreForRetrieval(score, ply) {
    if (!this.isMateScore(score)) return score;
    return score > 0 ? score - ply : score + ply;
  }
}
