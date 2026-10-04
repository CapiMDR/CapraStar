// Owns all premove state and validation. Premove entries are square pairs because their final move flags
// depend on the position after the opponent replies.
class PremoveQueue {
  constructor(engine, canPremove = () => true) {
    this.engine = engine;
    this.canPremove = canPremove;
    this.items = [];
  }

  hasItems() {
    return this.items.length > 0;
  }

  color() {
    return this.items[0]?.color;
  }

  canQueue(color) {
    return (
      this.canPremove(color) &&
      this.engine.result === GameResult.inProgress &&
      color !== this.engine.clrToMove &&
      (this.items.length === 0 || this.items[0].color === color)
    );
  }

  enqueue(color, from, to) {
    if (!this.canQueue(color) || from === to || !this.isPlausible(color, from, to)) return false;
    this.items.push({ color, from, to });
    return true;
  }

  clear() {
    this.items = [];
  }

  // Replay queued moves to determine which allied piece will occupy a future
  // start square. This is deliberately not a full chess legality simulation.
  getVirtualPieces(color) {
    const pieces = this.engine.board.piecesList.slice();
    for (const premove of this.items) {
      if (premove.color !== color) continue;
      let movingPiece = pieces[premove.from];
      pieces[premove.from] = none;

      const targetRank = BoardUtil.squareToRank(premove.to);
      if (Piece.type(movingPiece) === pawn && (targetRank === 0 || targetRank === 7)) movingPiece = Piece.newPiece(queen, color);
      pieces[premove.to] = movingPiece;

      if (Piece.type(movingPiece) === king && Math.abs(BoardUtil.squareToFile(premove.to) - BoardUtil.squareToFile(premove.from)) === 2) {
        const kingSide = BoardUtil.squareToFile(premove.to) > BoardUtil.squareToFile(premove.from);
        const rookFrom = BoardUtil.indexToSquare(kingSide ? 7 : 0, targetRank);
        const rookTo = BoardUtil.indexToSquare(kingSide ? 5 : 3, targetRank);
        pieces[rookTo] = pieces[rookFrom];
        pieces[rookFrom] = none;
      }
    }
    return pieces;
  }

  isPlausible(color, from, to) {
    const pieces = this.getVirtualPieces(color);
    const piece = pieces[from];
    if (Piece.type(piece) === none || Piece.clr(piece) !== color) return false;

    let occupancy = 0n;
    for (let square = 0; square < 64; square++) {
      if (Piece.type(pieces[square]) !== none) occupancy |= 1n << BigInt(square);
    }

    // BBUtil centralizes the movement maps for every piece type. Pawns need
    // their diagonal attack map in addition to their forward move map.
    let moves = BBUtil.getMoves(piece, from, occupancy);
    if (Piece.type(piece) === pawn) moves |= BBUtil.pawnAttacks(from, color);

    // Castling is a valid king movement pattern but is intentionally not part
    // of the king's attack map.
    const isCastlePattern =
      Piece.type(piece) === king &&
      Math.abs(BoardUtil.squareToFile(to) - BoardUtil.squareToFile(from)) === 2 &&
      BoardUtil.squareToRank(to) === BoardUtil.squareToRank(from);
    return isCastlePattern || (moves & (1n << BigInt(to))) !== 0n;
  }

  // Executes one queued move when its player receives the turn. If it is not
  // legal in that new position, every queued premove is discarded.
  playNext() {
    const next = this.items[0];
    const engine = this.engine;
    if (!this.canPremove(next?.color)) {
      this.clear();
      return false;
    }
    if (!next || engine.clrToMove !== next.color) return false;
    if (engine.result !== GameResult.inProgress) {
      this.clear();
      return false;
    }

    const matchingMoves = engine.moves.filter((move) => Move.startSqr(move) === next.from && Move.targetSqr(move) === next.to);
    // If the premove is a pawn promotion, we will always promote to a queen.
    const move = matchingMoves.find((candidate) => Move.flag(candidate) === promoteQueenFlag) || matchingMoves[0];
    if (move === undefined) {
      this.clear();
      return false;
    }

    this.items.shift();
    engine.playMove(move);
    return true;
  }
}
