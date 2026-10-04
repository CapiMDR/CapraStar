/* 🐐 CapraStar - The Greatest of All Tactics 🐐 */
//This Bot will for sure Checkmaaaaate you

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
    //Empty CapraStar's copy of the board
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

//CapraStar bot implementation
class CapraStar{
  constructor(board){
    this.board=board;
    this.moveGen=new MoveGenerator();
    this.initialize(); //Contains constants the bot uses like piece-square tables, etc
    
    //Holds the best move found on every turn
    this.bestMoveFound=0;
    this.evaluation=0;
  }
  
  //Receives list of legal moves and returns the best one
  getBestMove(legalMoves){
    //Attempting to get a book move without searching
    const bookMove = getBookMove(this.board);
    if(bookMove) return bookMove;
    
    this.bestMoveFound=legalMoves[0]; //If for some reason no move is found play the first
    
    const piecesCount=this.board.pieceCounts[white][0]+this.board.pieceCounts[black][0];
    let depth;
    
    if(piecesCount>5) depth=4;
    else if(piecesCount>3) depth=6;
    else depth=8;
    
    this.evaluation=this.negaMax(-Infinity, Infinity, depth, 0,0);
    
    return this.bestMoveFound;
  }
  
  negaMax(alph, beta, depth, ply, currExtensions){
    if(ply>0){
      //Returns draw evaluation if 50 move counter reached
      if(this.board.plyCounter==100) return 0;
      
      //If forced mate has been found already stop searching
      alph=Math.max(alph,-this.mateScore+ply);
      beta=Math.min(beta,this.mateScore-ply);
      if(alph>=beta) return alph;
    }
    
    const zobristHash=this.board.zobristKey;
    const entry = this.transpositionTable.get(zobristHash);
    //If we have seen this position from a different move order before
    if (entry && entry.depth >= depth) {
      let ttScore = this.adjustMateScoreForRetrieval(entry.bestScore, ply);
      if (entry.flag === 'EXACT') return ttScore;
      if (entry.flag === 'ALPHA' && ttScore <= alph) return alph;
      if (entry.flag === 'BETA' && ttScore >= beta) return beta;
    }
    
    if(depth==0) return this.quiescence(alph,beta);
    let moves=this.moveGen.generateMoves(this.board);
    
    if(moves.length==0){
      if(this.moveGen.inCheck) return -this.mateScore+ply;
      return 0;
    }
    
    let bestScore=-Infinity;
    const firstAlpha=alph;
    const firstBeta=beta;
    moves=this.sortMoves(moves, this.board, this.moveGen.enemyAttacksMask, ply);
    let bestMoveLocal=moves[0];
    
    for(let move of moves){
      this.board.makeMove(move);
       
      //Extending searches for checks and pawns about to promote
      let extensions=0;
      if(currExtensions<this.maxExtensions){
        if(this.board.inCheck()) extensions=1;
        
        const movedPiece=this.board.piecesList[Move.targetSqr(move)];
        const targetRank=BoardUtil.squareToRank(Move.targetSqr(move));
        if(Piece.type(movedPiece)==pawn && (targetRank==1 || targetRank==6)) extensions=1;
      }
      
      const score = -this.negaMax(-beta, -alph, depth-1+extensions, ply+1, currExtensions+extensions);
      this.board.unmakeMove(move);
      if(score>bestScore){
        bestScore=score;
        bestMoveLocal=move;
        //If root node, this is the best move
        if(ply==0) this.bestMoveFound=move;
        if(score>alph) alph=score;
      }
      
      if (score >= beta) {
        // Killer move update
        if (!Move.isCapture(move, this.board)) {
          this.killerMoves[ply][1] = this.killerMoves[ply][0];
          this.killerMoves[ply][0] = move;

          // History heuristic update
          const attackerPiece = this.board.piecesList[Move.startSqr(move)];
          const pieceType = Piece.type(attackerPiece);
          const targetSquare = Move.targetSqr(move);

          this.historyHeuristic[pieceType][targetSquare] += depth * depth; 
        }
        break;
      }
    }
    
    let flag;
    if (bestScore <= firstAlpha) flag = 'ALPHA';
    else if (bestScore >= firstBeta) flag = 'BETA';
    else flag = 'EXACT';
    
    let storedScore = this.adjustMateScoreForStorage(bestScore, ply);

    this.transpositionTable.set(zobristHash, {
      depth,
      bestScore: storedScore,
      flag,
      bestMoveLocal
    });
    
    return bestScore;
  }
  
  isMateScore(score) {
    return Math.abs(score) > this.mateScore - 1000; //Near mate
  }

  adjustMateScoreForStorage(score, ply) {
    if (this.isMateScore(score)) {
      if (score > 0) return score + ply;  //Sooner mate for us is bigger
      else return score - ply;            //Sooner mate for opponent is smaller
    }
    return score;
  }

  adjustMateScoreForRetrieval(score, ply) {
    if (this.isMateScore(score)) {
      if (score > 0) return score - ply;  //Undo storage adjustment
      else return score + ply;
    }
    return score;
  }
  
  quiescence(alph, beta){
    const evaluation = this.evaluate(this.board);
    let bestValue=evaluation;
    if(bestValue>=beta) return bestValue;
    if(bestValue>alph) alph = bestValue;
    
    const deltaMargin = 50;
    let captureMoves=this.moveGen.generateMoves(this.board,true);
    captureMoves=this.sortMoves(captureMoves, this.board, this.moveGen.enemyAttacksMask);
    
    for(let capture of captureMoves){
      const capturedType = Move.capturePieceType(capture, this.board);
      const capturedValue = this.pieceValues[capturedType];
      
      //Delta pruning
      if(!Move.isPromotion(capture)){ //Not allowing pruning of promotion captures
        if(bestValue + capturedValue + deltaMargin < alph) continue; 
      }
      
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
  
  //Sorts the capture moves in descending order to look at the best captures first during quiescence
  sortMoves(moves, board, enemyAttackMask, ply = 0) {
    const ttEntry = this.transpositionTable[board.hashKey];
    let ttMove = ttEntry ? ttEntry.bestMove : null;
    
    const scoredMoves = moves.map(m => {
      //MVVLA capture heuristic
      let score = this.getMVVLVA(m, board);
      
      //Look at the best move of transpositions first
      if (ttMove && m == ttMove) score += 500000; 
      
      //Killer moves in other branches
      if (this.killerMoves[ply].includes(m)) score += 10000;
      if (Move.isPromotion(m)) score += 20000;
      if (!Move.isCapture(m, board)) {
        const attacker = board.piecesList[Move.startSqr(m)];
        score += this.historyHeuristic[Piece.type(attacker)][Move.targetSqr(m)];
      }
      
      //Penalize moves for having a target square controlled by the opponent
      if((enemyAttackMask & BigInt(Move.targetSqr(m))) != 0) score-=500;
      
      return { move: m, score };
    });
    return scoredMoves.sort((a, b) => b.score - a.score).map(e => e.move);
  }
  
  //Calculates which game phase we are currently on (24 if all pieces remain, 0 if just kings)
  //to smoothly interpolate between piece square table values
  calcGamePhase(board){
    let phase=0;
    phase+=this.phaseValues[pawn]*(board.pieceCounts[white][pawn]+board.pieceCounts[black][pawn]);
    phase+=this.phaseValues[knight]*(board.pieceCounts[white][knight]+board.pieceCounts[black][knight]);
    phase+=this.phaseValues[bishop]*(board.pieceCounts[white][bishop]+board.pieceCounts[black][bishop]);
    phase+=this.phaseValues[rook]*(board.pieceCounts[white][rook]+board.pieceCounts[black][rook]);
    phase+=this.phaseValues[queen]*(board.pieceCounts[white][queen]+board.pieceCounts[black][queen]);
    //Clamping phase in case of weird positions
    if (phase<0) phase=0;
    if (phase>this.totalPhase) phase=this.totalPhase;
    return phase;
  }
  
  //TODO: Evaluate pawn quality (defended/passed) and incorporate end PST
  //Passing board as a parameter to allow for evaluation on a position the bot isn't playing in for testing
  evaluate(board){
    const perspectiveMult=(board.clrToMove==white) ? 1 : -1;
    const phase=this.calcGamePhase(board);
    let allPiecesBB=board.piecesBB;
    
    let evaluation=0;
    let whiteMaterial=0;
    let blackMaterial=0;
    
    let hasBishop={
      light : [false, false],
      dark: [false, false]
    }
    
    while (allPiecesBB != 0n) {
      const sqr = BBUtil.getLSBIndex(allPiecesBB);
      const piece = board.piecesList[sqr];
      const pieceType = Piece.type(piece);
      const pieceClr = Piece.clr(piece);
      const sign=(pieceClr==white) ? 1 : -1;
      const index=(pieceClr==white) ? sqr : BoardUtil.mirrorIndex(sqr);
      let pieceValue=0;
      
      switch (pieceType) {
        case pawn: 
          const midPValue = this.pawnEarlyPST[index]; // middlegame PST
          const endPValue = this.pawnEndPST[index]; // endgame PST
          pieceValue = this.pieceValues[pawn];
          pieceValue += ((midPValue * phase) + (endPValue * (this.totalPhase - phase))) / this.totalPhase;
        break;
        case knight: pieceValue = this.pieceValues[knight] + this.knightPST[index];
        break;
        case bishop: 
          pieceValue = this.pieceValues[bishop] + this.bishopPST[index];
          const bishopType=(BoardUtil.isLightSquare(sqr)) ? hasBishop.light : hasBishop.dark;
          bishopType[pieceClr]=true;
        break;
        case rook: pieceValue = this.pieceValues[rook] + this.rookPST[index];
        break;
        case queen: pieceValue = this.pieceValues[queen] + this.queenPST[index]; 
        break;
        case king:
          const midKValue = this.kingEarlyPST[index]; // middlegame PST
          const endKValue = this.kingEndPST[index]; // endgame PST
          pieceValue = ((midKValue * phase) + (endKValue * (this.totalPhase - phase))) / this.totalPhase;
        break;
      }
      
      if(pieceClr==white){
        whiteMaterial+=this.pieceValues[pieceType];
      }else{
        blackMaterial+=this.pieceValues[pieceType];
      }
      
      evaluation += pieceValue * sign;
      allPiecesBB &= allPiecesBB - 1n;
    }
    
    //Giving extra bonus for having pair of bishops
    if(hasBishop.light[white] && hasBishop.dark[white]) evaluation+=50;
    if(hasBishop.light[black] && hasBishop.dark[black]) evaluation-=50;
    
    const pieceCount=board.pieceCounts[white][0]+board.pieceCounts[black][0];
    const wKingSquare = BBUtil.getLSBIndex(board.white.king);
    const bKingSquare = BBUtil.getLSBIndex(board.black.king);
    const blackIndex = BoardUtil.mirrorIndex(bKingSquare);

    //Detecting forced mate scenarios
    const whiteKRvsK = (whiteMaterial == this.pieceValues[rook] && blackMaterial == 0);
    const blackKRvsK = (blackMaterial == this.pieceValues[rook] && whiteMaterial == 0);
    const whiteKQvsK = (whiteMaterial == this.pieceValues[queen] && blackMaterial == 0);
    const blackKQvsK = (blackMaterial == this.pieceValues[queen] && whiteMaterial == 0);

    //When the endgame begins (arbitrarily less than 8 pieces for now) use mop-up scores
    if (pieceCount <= 8) {
      //Mop-up logic for endgames
      evaluation += this.calcMopUpScore(wKingSquare, bKingSquare, whiteMaterial, blackMaterial);
      evaluation -= this.calcMopUpScore(bKingSquare, wKingSquare, blackMaterial, whiteMaterial);
      if (whiteKRvsK || whiteKQvsK) {
        const distance = BoardUtil.manhattanDistances[bKingSquare][wKingSquare];
        const edgeDist = BoardUtil.distanceToCenter[bKingSquare];
        evaluation += 2000 - distance * 50 + edgeDist * 150;
      }
      if (blackKRvsK || blackKQvsK) {
        const distance = BoardUtil.manhattanDistances[wKingSquare][bKingSquare];
        const edgeDist = BoardUtil.distanceToCenter[wKingSquare];
        evaluation -= 2000 - distance * 50 + edgeDist * 150;
      }
      
    } else {    
      //Giving penalty for the king having many legal moves (undefended king) when not in endgame
      const wKingMoves=BBUtil.queenMoves(wKingSquare,board.piecesBB);
      evaluation-=BBUtil.countBits(wKingMoves); //If white king has a lot of moves it is good for black
      const bKingMoves=BBUtil.queenMoves(bKingSquare,board.piecesBB);
      evaluation+=BBUtil.countBits(bKingMoves); //If black king has a lot of moves it is good for white
    }
    
    //Small bonus for being the player to move
    evaluation+=30*perspectiveMult;
    
    return evaluation*perspectiveMult;
  }
  
  calcMopUpScore(allyKingSqr, enemyKingSqr, allyMaterial, enemyMaterial){
    //Only encourage to move the king closer if up material
    if(allyMaterial<enemyMaterial) return 0;
    
    let mopUpScore=0;
    mopUpScore+=(14-BoardUtil.manhattanDistances[allyKingSqr][enemyKingSqr])*500;
    
    //Encourage moving opponent king to edges
    mopUpScore+=BoardUtil.distanceToCenter[enemyKingSqr]*100;
    
    return mopUpScore;
  }
  
  //Initializes constants unique to the bot
  initialize(){
    //Standard piece values (none, pawns, knights, bishops, rooks, queens, king)
    this.pieceValues=[0,100,300,350,500,900,0]
    this.mateScore=10000000;
    this.maxExtensions=16;
    this.killerMoves = Array.from({ length: 64 }, () => [null, null]);
    this.historyHeuristic = Array.from({ length: 7 }, () => Array(64).fill(0));
    
    this.transpositionTable = new Map();
    
    //How much each piece contributes to the "middlegame phase"
    this.phaseValues = [0,0,1,1,2,4,0];

    this.totalPhase = 24;
    
    /*PieceSquare tables*/
    //Initialized from white's point of view but indeces get mirrored in evaluation if black
    
    this.pawnEarlyPST = [
      0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0
    ];
    
    this.pawnEndPST = [
      0,   0,   0,   0,   0,   0,   0,   0,
      150, 160, 160, 170, 170, 160, 160, 150,
      120, 125, 125, 130, 130, 125, 125, 120,
      100, 105, 105, 110, 110, 105, 105, 100,
      80,  85,  85,  90,  90,  85,  85,  80,
      60,  65,  65,  70,  70,  65,  65,  60,
      70,  70,  70,  70,  70,  70,  70,  70,
      0,   0,   0,   0,   0,   0,   0,   0
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
    
    this.kingEarlyPST = [
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20
    ];
    
    this.kingEndPST = [
      -50,-40,-30,-20,-20,-30,-40,-50,
      -30,-20,-10,  0,  0,-10,-20,-30,
      -30,-10, 20, 30, 30, 20,-10,-30,
      -30,-10, 30, 40, 40, 30,-10,-30,
      -30,-10, 30, 40, 40, 30,-10,-30,
      -30,-10, 20, 30, 30, 20,-10,-30,
      -30,-30,  0,  0,  0,  0,-30,-30,
      -50,-30,-30,-30,-30,-30,-30,-50
    ];
  }
}