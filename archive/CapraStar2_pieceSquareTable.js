//This file is reserved for older versions of CapraStar/other bots for benchmarking performance/ELO

//Web worker script for the ai to run in parallel to the UI

importScripts('BoardUtil.js?v=${Date.now()}','Perft.js?v=${Date.now()}','Constants.js?v=${Date.now()}','BBUtil.js?v=${Date.now()}', 'Piece.js?v=${Date.now()}','Zobrist.js?v=${Date.now()}', 'GameState.js?v=${Date.now()}', 'Board.js?v=${Date.now()}','Move.js?v=${Date.now()}','MoveGenerator.js?v=${Date.now()}');

let capraStar = null;
let book = {}; //Map of book moves passed from sketch.js

onmessage = function(e) {
  const {type, fen} = e.data;
  if (type === 'init') {
    book = e.data.book;
    capraStar = new CapraStar(new Board());
  }
  else if (type === 'search') {
    if (!capraStar) capraStar = new CapraStar(new Board());
    //Empty Bot's copy of the board
    capraStar.board.init();
    //Reconstruct current board from FEN
    capraStar.board.fillBoard(fen);
    
    //Get best move
    const legalMoves = capraStar.moveGen.generateMoves(capraStar.board);
    let bestMove = capraStar.getBestMove(legalMoves);
    
    postMessage({
        type: 'result',
        bestMove: bestMove,
        evaluation: capraStar.evaluation
    });
  }
};

function getBookMove(board) {
  const fen = board.toFEN(false, false) + " -";
  const moves = book[fen];
    
  if(moves){
    // Pick a random move from the book
    const pickedMove=moves[Math.floor(Math.random() * moves.length)];
    return Move.UCIToMove(pickedMove, board);
  }
  return null;
}

class CapraStar{
  constructor(board){
    this.board=board;
    this.moveGen = new MoveGenerator();
    this.initialize();
  }
  
  //Receives list of legal moves and plays the best one
  getBestMove(legalMoves){
    const start = performance.now();
    let bestMove=legalMoves[0];
    let bestScore=-100000000;
    
    for(let move of legalMoves){
      this.board.makeMove(move);
      const score = -this.negaMax(-100000000, 100000000, 2);
      this.board.unmakeMove(move);
      if(score>bestScore){
        bestScore=score;
        bestMove=move;
      }
    }
    
    const end = performance.now();
    //console.log("Execution time: " + (end - start) + "ms");
    //console.log("Evaluation: " + bestScore);
    return bestMove;
  }
  
  negaMax(alph, beta, depth){
    if(depth==0) return this.evaluate(this.board);
    let bestScore=-100000000;
    const moves=this.moveGen.generateMoves(this.board);
    
    if(moves.length==0){
      if(this.moveGen.inCheck) return -100000000;
      return 0;
    }
    
    for(let move of moves){
      this.board.makeMove(move);
      const score = -this.negaMax(-beta, -alph, depth-1);
      this.board.unmakeMove(move);
      if(score>bestScore){
        bestScore=score;
        if(score>alph) alph=score;
      }
      if(score>=beta) return bestScore;
    }
    return bestScore;
  }
  
  //Passing board as a parameter to allow for evaluation on a position the bot isn't playing in for testing
  evaluate(board){
    const mult=(board.clrToMove==white) ? 1 : -1;
    let allPiecesBB=board.piecesBB;
    let evaluation=0;
    
    while (allPiecesBB != 0n) {
      const sqr = BBUtil.getLSBIndex(allPiecesBB);
      const piece = board.piecesList[sqr];
      const pieceType = Piece.type(piece);
      const pieceClr = Piece.clr(piece);
      const sign=(pieceClr==white) ? 1 : -1;
      const index=(pieceClr==white) ? sqr : BoardUtil.mirrorIndex(sqr);
      let pieceValue=0;
      switch (pieceType) {
        case pawn: pieceValue = this.pawnValue + this.pawnPST[index]; 
          break;
        case knight: pieceValue = this.knightValue + this.knightPST[index]; 
          break;
        case bishop: pieceValue = this.bishopValue + this.bishopPST[index]; 
          break;
        case rook: pieceValue = this.rookValue + this.rookPST[index]; 
          break;
        case queen: pieceValue = this.queenValue + this.queenPST[index]; 
          break;
        case king: pieceValue = this.kingPST[index]; 
          break;
      }
      allPiecesBB &= allPiecesBB - 1n;
      evaluation += sign * pieceValue;
    }
    
    return evaluation*mult;
  }
  
  //Initializes constants unique to the bot
  initialize(){
     this.pawnValue=10;
     this.knightValue=30;
     this.bishopValue=30;
     this.rookValue=50;
     this.queenValue=90;
    
    /*PieceSquare tables*/
    //Initialized from white's point of view but indeces get mirrored in evaluation if black
    
    this.pawnPST = [
      0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0
    ];
    
    this.knightPST = [
      -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50,
    ];
    
    this.bishopPST = [
      -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20,
    ];
    
    this.rookPST = [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0
    ];
    
    this.queenPST = [
      -20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20
    ];
    
    this.kingPST = [
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20
    ];
  }
}