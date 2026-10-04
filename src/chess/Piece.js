/*
types
  0 = none = x000
  1 = pawn = x001
  2 = knight = x010
  3 = bishop = x011
  4 = rook = x100
  5 = queen = x101
  6 = king = x110

colors
  black = 0xxx
  white = 1xxx
*/

//Pieces are represented as 4 bit ints (first bit = color, last 3 bits = type)
class Piece{
  //Returns the color of a given piece (0=black 1=white)
  static clr(piece){
    return (piece & this.colorMask) >> 3;
  }
  
  //Returns the type of a given piece
  static type(piece){
    return piece & this.typeMask;
  }
  
  //Creates a new piece, color is transformed from 0/1 (black or white in move turn representation) to piece mask color (0/8) 
  static newPiece(type, clr){
    const pieceClr = (clr == black) ? 0 : 8;
    return type | pieceClr;
  }
  
  static isColor(piece, clr){
    return this.clr(piece)==clr;
  }
  
  static isEnemy(piece, other){
    return this.clr(piece) != this.clr(other); 
  }
  
  static isAlly(piece, other){
    return this.clr(piece) == this.clr(other); 
  }
  
  //Prints piece in 4-bit binary format OR in character representation
  static toString(piece, sendBinary=false){
    if(sendBinary) return piece.toString(2).padStart(4, '0');
    
    const type=this.type(piece);
    const clr=this.clr(piece);
    let symbol='.';
    switch(type){
      case pawn: symbol='p';
      break;
      case knight: symbol='n';
      break;
      case bishop: symbol='b';
      break;
      case rook: symbol='r';
      break;
      case queen: symbol='q';
      break;
      case king: symbol='k';
      break;
    }
    symbol=(clr==white) ? symbol.toUpperCase() : symbol;
    return symbol;
  }
}

Piece.colorMask=0b1000;
Piece.typeMask=0b0111;
//Indeces of each piece type (ex 1 = 0001 = black pawn, 14 = 1110 = white king)
Piece.indeces=[1,2,3,4,5,6,9,10,11,12,13,14];