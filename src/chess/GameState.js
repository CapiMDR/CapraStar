//Acts as a bundle to store irreversible aspects of a position on a board
class GameState{
  constructor(enPassantFile, plyCounter, hasCastleRight, capturedPieceType, zobristKey){
    this.enPassantFile=enPassantFile;
    this.plyCounter=plyCounter;
    //Deep copies the castling rights object with its arrays (queen side & king side)
    this.hasCastleRight=structuredClone(hasCastleRight);
    this.capturedPieceType=capturedPieceType;
    this.zobristKey=zobristKey;
  }
}