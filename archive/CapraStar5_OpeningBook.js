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
    this.moveGen=new MoveGenerator();
    this.initialize();
    
    //Holds the best move found on every turn
    this.bestMoveFound=0;
  }
  
  //Receives list of legal moves and returns the best one
  getBestMove(legalMoves){
    
    //Attempting to get a book move without searching
    const bookMove = getBookMove(this.board);
    if(bookMove) return bookMove;
    
    this.bestMoveFound=legalMoves[0]; //If for some reason no move is found play the first
    
    const piecesCount=this.board.pieceCounts[white][0]+this.board.pieceCounts[black][0];
    const depth=(piecesCount>5) ? 4 : 4;
    this.negaMax(-Infinity, Infinity, depth, true);
    
    return this.bestMoveFound;
  }
  
  negaMax(alph, beta, depth, isRoot=false){
    const zobristHash=this.board.zobristKey;
    const entry = this.transpositionTable.get(zobristHash);
    //If we have seen this position from a different move order before
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'EXACT') return entry.bestScore;
      if (entry.flag === 'ALPHA' && entry.bestScore <= alph) return alph;
      if (entry.flag === 'BETA' && entry.bestScore >= beta) return beta;
    }
    
    
    if(depth==0) return this.quiescence(alph,beta);
    let moves=this.moveGen.generateMoves(this.board);
    
    if(moves.length==0){
      if(this.moveGen.inCheck) return -Infinity;
      return 0;
    }
    
    let bestScore=-Infinity;
    const firstAlpha=alph;
    const firstBeta=beta;
    moves=this.sortMoves(moves, this.board);
    let bestMoveLocal=moves[0];
    
    for(let move of moves){
      this.board.makeMove(move);
      const score = -this.negaMax(-beta, -alph, depth-1, false);
      this.board.unmakeMove(move);
      if(score>bestScore){
        bestScore=score;
        bestMoveLocal=move;
        if(isRoot) this.bestMoveFound=move;
        if(score>alph) alph=score;
      }
      if(score>=beta) break;
    }
    
    let flag;
    if (bestScore <= firstAlpha) flag = 'ALPHA';
    else if (bestScore >= firstBeta) flag = 'BETA';
    else flag = 'EXACT';
    
    this.transpositionTable.set(zobristHash, {
      depth,
      bestScore,
      flag,
      bestMoveLocal
    });
    
    return bestScore;
  }
  
  quiescence(alph, beta){
    const evaluation = this.evaluate(this.board);
    let bestValue=evaluation;
    if(bestValue>=beta) return bestValue;
    if(bestValue>alph) alph = bestValue;
    
    let captureMoves=this.moveGen.generateMoves(this.board,true);
    captureMoves=this.sortMoves(captureMoves, this.board);
    
    for(let capture of captureMoves){
      //Treating promotions as gaining a queen (+90)
      const value=(Move.isPromotion(capture)) ? 90 : this.pieceValues[Move.capturePieceType(capture, this.board)];
      //Delta pruning (+50 margin)
      if(bestValue + value + 50 < alph) continue;
      
      this.board.makeMove(capture);
      const score = -this.quiescence(-beta, -alph);
      this.board.unmakeMove(capture);
      
      if(score>=beta) return score;
      if(score>bestValue) bestValue=score;
      if(score>alph) alph=score;
    }
    return bestValue;
  }
  
  //Generates the "value" of a capture move
  //Capturing a queen with a pawn is usually preferable over capturing a pawn with a queen
  getMVVLVA(move, board){
    const attackerPiece=board.piecesList[Move.startSqr(move)];
    const victimType=Move.capturePieceType(move,board);
    const attackerType=Piece.type(attackerPiece);
    
    if(victimType==none) return 0;
    
    return this.pieceValues[victimType]*10-this.pieceValues[attackerType];
  }
  
  //TODO: Implement a complete move sorter (consider checks/defenders, etc)
  //Sorts the capture moves in descending order to look at the best captures first during quiescence
  sortMoves(moves, board) {
    return moves.sort((a, b) => this.getMVVLVA(b, board) - this.getMVVLVA(a, board));
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
        case pawn: pieceValue = this.pieceValues[pawn] + this.pawnPST[index]; 
          break;
        case knight: pieceValue = this.pieceValues[knight] + this.knightPST[index]; 
          break;
        case bishop: pieceValue = this.pieceValues[bishop] + this.bishopPST[index]; 
          break;
        case rook: pieceValue = this.pieceValues[rook] + this.rookPST[index]; 
          break;
        case queen: pieceValue = this.pieceValues[queen] + this.queenPST[index]; 
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
    //Standard piece values (none, pawns, knights, bishops, rooks, queens)
    this.pieceValues=[0,10,30,35,50,90]
    
    this.transpositionTable = new Map();
    
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