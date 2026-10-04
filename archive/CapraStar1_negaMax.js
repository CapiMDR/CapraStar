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

/*Place holder file for any outdated bot version*/
class CapraStar{
  constructor(board){
    this.board=board;
    this.initialize();
    this.moveGen = new MoveGenerator();
  }
  
  /*play(legalMoves){
    const randomMove=random(legalMoves);
    this.engine.playMove(randomMove);
  }*/
  
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
    const valueMultiplier=1;
    
    const pieceCounts=board.pieceCounts;
    const whitePawnsValue=pieceCounts[white][pawn] * this.pawnValue;
    const blackPawnsValue=pieceCounts[black][pawn] * this.pawnValue;
    const whiteKnightsValue=pieceCounts[white][knight] * this.knightValue;
    const blackKnightsValue=pieceCounts[black][knight] * this.knightValue;
    const whiteBishopsValue=pieceCounts[white][bishop] * this.bishopValue;
    const blackBishopsValue=pieceCounts[black][bishop] * this.bishopValue;
    const whiteRooksValue=pieceCounts[white][rook] * this.rookValue;
    const blackRooksValue=pieceCounts[black][rook] * this.rookValue;
    const whiteQueensValue=pieceCounts[white][queen] * this.queenValue;
    const blackQueensValue=pieceCounts[black][queen] * this.queenValue;
    
    const whiteMaterial=whitePawnsValue+whiteKnightsValue+whiteBishopsValue+whiteRooksValue+whiteQueensValue;
    const blackMaterial=blackPawnsValue+blackKnightsValue+blackBishopsValue+blackRooksValue+blackQueensValue;
    
    return valueMultiplier * (whiteMaterial-blackMaterial) * mult;
  }
  
  initialize(){
    //Standard piece values
    this.pawnValue=10;
    this.knightValue=30;
    this.bishopValue=30;
    this.rookValue=50;
    this.queenValue=90;
  }
}