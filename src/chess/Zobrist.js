//A zobrist key class (64 bits) for mapping a whole board position to a look-up table
//Used for transposition table during bot searches
class Zobrist{
  static computeZobristHash(board) {
    let hash = 0n;
  
    for(let sqr=0;sqr<64;sqr++){
      const piece = board.piecesList[sqr];
      if(Piece.type(piece)!=none) hash ^= this.pieces[sqr][piece];
    }

    if (board.clrToMove==black) hash ^= this.blackToMove;
    
    hash ^= this.castlingRights[this.castleRightsToIndex(board)];
    
    if (board.enPassantFile!=undefined) hash ^= this.enPassant[board.enPassantFile];

    return hash;
  }
  
  //Transforms 4 booleans from castling rights to 4 bit integer (0-15)
  static castleRightsToIndex(board){
    const wKingSide=board.hasCastleRight.kingSide[white];
    const wQueenSide=board.hasCastleRight.queenSide[white];
    const bKingSide=board.hasCastleRight.kingSide[black];
    const bQueenSide=board.hasCastleRight.queenSide[black];
    return (wKingSide << 3) | (wQueenSide << 2) | (bKingSide << 1) | (bQueenSide << 0);
  }
}

//Seed for random number generation is located in Constants.js
Zobrist.pieces = [];
for(let sqr=0;sqr<64;sqr++){
  Zobrist.pieces[sqr]=[];
  for(let piece of Piece.indeces){
    Zobrist.pieces[sqr][piece] = rand64();
  }
}

Zobrist.blackToMove=rand64();
Zobrist.castlingRights=[];
for(let i=0;i<16;i++){
  Zobrist.castlingRights[i]=rand64();
}

Zobrist.enPassant=[];
for(let i=0;i<8;i++){
  Zobrist.enPassant[i]=rand64();
}