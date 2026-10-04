class BoardUtil{
  /*Utility methods for board/squares (self explanatory)*/
  static indexToSquare(file, rank){
    return 8 * rank + file;
  }
  
  static squareToFile(sqr){
    return sqr % 8;
  }
  
  static squareToRank(sqr){
    return Math.floor(sqr / 8);
  }
  
  static isValidSquare(file, rank){
    //If no rank was given we assume the file is a square (0-63) (no function overloading in js)
    if(rank==null) return (file>=0 && file<64);
    //Otherwise check if file and rank are within (0-7)
    return (file >= 0 && file < 8 && rank >= 0 && rank < 8);
  }
  
  //Given number of a square (0-63), return the name (ex: 36 -> e4)
  static sqrToString(sqr){
    const file=this.squareToFile(sqr);
    const fileSymbol=String.fromCharCode(97 + file);
    const rank=8-this.squareToRank(sqr).toString();
    return fileSymbol+""+(rank);
  }
  
  //Given a file number, returns its letter
  static fileToChar(file) {
    return String.fromCharCode("a".charCodeAt(0) + file);
  }

  //Given a letter, returns the file number
  static charToFile(file) {
    return file.charCodeAt(0) - "a".charCodeAt(0);
  }
  
  static nameToFile(sqr) {
    const fileChar = sqr[0].toLowerCase();
    const file = fileChar.charCodeAt(0) - 'a'.charCodeAt(0);
    return file;
  }
  
  static nameToRank(sqr) {
    const rankChar = sqr[1];
    const rank = parseInt(rankChar, 10) - 1;
    return 7-rank;
  }
  
  //Given the name of a square, returns its index (0-63, ex e4=36)
  static nameToSquare(sqr){
    const file=this.nameToFile(sqr);
    const rank=this.nameToRank(sqr);
    return this.indexToSquare(file,rank);
  }
  
  //Turns square coords or number to name (ex 36 = 4,4 = e4)
  static indexToName(file, rank) {
    //If no rank was given we assume the file is a square (0-63)
    const files="abcdefgh";
    if(rank==undefined) {
      const idx=file;
      file=idx%8;
      rank = 7 - Math.floor(idx / 8);
    } else {
      rank = 7 - rank;
    }
    return files[file] + (rank + 1);
  }
  
  static isLightSquare(file, rank){
    //If no rank was given we assume the file is a square (0-63)
    let sqrFile=file;
    let sqrRank=rank;
    if(sqrRank==null){
      sqrFile=this.squareToFile(file);
      sqrRank=this.squareToRank(file);
    }
    return (sqrFile + sqrRank) % 2 === 0;
  }
  
  //Mirrors a given index on an 8x8 matrix for piece square table
  static mirrorIndex(index) {
    const rank = Math.floor(index / 8);
    const file = index % 8;
    const mirroredRank = 7 - rank;
    return mirroredRank * 8 + file;
  }
  
  //Given a coord determine if it is outside the visual chess board
  static outOfBounds(x,y){
    return (x<0 || y<0 || x>7 || y>7);
  }
  
  //Precomputes manhattan distance between every pair of squares
  static preComputeManhattanDistances(){
    const distances=Array(64).fill(null).map(() => Array(64).fill(0));
    for (let sqr1=0;sqr1<64;sqr1++) {
    const file1=this.squareToFile(sqr1);
    const rank1=this.squareToRank(sqr1);
      for (let sqr2=0;sqr2<64;sqr2++) {
        const file2=this.squareToFile(sqr2);
        const rank2=this.squareToRank(sqr2);
        distances[sqr1][sqr2]=Math.abs(file1 - file2) + Math.abs(rank1 - rank2);
      }
    }
    
    return distances;
  }
}

BoardUtil.distanceToCenter = [
  3, 3, 3, 3, 3, 3, 3, 3,
  3, 2, 2, 2, 2, 2, 2, 3,
  3, 2, 1, 1, 1, 1, 2, 3,
  3, 2, 1, 0, 0, 1, 2, 3,
  3, 2, 1, 0, 0, 1, 2, 3,
  3, 2, 1, 1, 1, 1, 2, 3,
  3, 2, 2, 2, 2, 2, 2, 3,
  3, 3, 3, 3, 3, 3, 3, 3
]

BoardUtil.manhattanDistances=BoardUtil.preComputeManhattanDistances();