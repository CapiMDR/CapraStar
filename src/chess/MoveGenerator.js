//Creates all legal moves for the player to move given a board
class MoveGenerator{  
  initialize(board, onlyCaptures=false){
    //Stores all the pin rays to detect which pieces are pinned (if they are on a pin ray)
    this.pinRaysMask=0n;
    //Stores which pin ray is the pinned piece limited to move in (indexed by the piece's square)
    this.pinnedRays=[];
    //If in check, determines the squares the current player can move to (either block check or capture checking piece). 
    //If not in check every bit is a 1 (every square is allowed)
    this.checkRaysMask=0n;
    this.inCheck=false;
    this.inDoubleCheck=false;
    this.capturesOnlyMask=0n;
    this.enemySlidingAttacksMask=0n;
    this.enemyKnightAttacksMask=0n;
    this.enemyAttacksMask=0n;
    this.enemyPawnAttacksMask=0n;
    
    //Helper variables
    this.allyColor=board.clrToMove;
    this.enemyColor=board.otherColor(this.allyColor);
    this.allyPieces=board.getAllies(this.allyColor);
    this.allyKingSqr=BBUtil.getLSBIndex(this.allyPieces.king);
    this.enemyPieces=board.getEnemies(this.allyColor);
    this.allPieces=board.piecesBB;
    this.emptySqrs=~this.allPieces;
    this.enemyOrEmptySqrs=this.enemyPieces.pieces | this.emptySqrs;
    
    //If only generating captures, this is set to only allow moves to enemy pieces
    //otherwise allow all squares to be moved to (fill with 1's)
    this.capturesOnlyMask=(onlyCaptures==true) ? this.enemyPieces.pieces : 18446744073709551615n;  
  }
  
  generateMoves(board, onlyCaptures=false){
    let moves=[];
    
    this.initialize(board, onlyCaptures);
    
    //First calculate square limitations by checks/pins & enemy attacked squares
    this.calcAllyKingRays(board);
    const enemySlidingAttacksMask = this.getEnemySlidingAttackMask();
    const enemyKnightAttacksMask = this.getEnemyKnightAttackMask();
    const enemyPawnAttacksMask = this.getEnemyPawnAttackMask();
    const enemyKingAttacksMask = this.getEnemyKingAttackMask();
    
    this.enemyPawnAttacksMask=enemyPawnAttacksMask;
    
    this.enemyAttacksMask=enemyKnightAttacksMask | enemySlidingAttacksMask | enemyPawnAttacksMask | enemyKingAttacksMask;
    
    //If not in check, every square is allowed to be moved to (set all 1's)
    if(!this.inCheck) this.checkRaysMask=18446744073709551615n;
    
    //Then generate legal moves using check & pin masks calculated
    this.generateKingMoves(moves, board, onlyCaptures);
    if(this.inDoubleCheck) return moves; //When in double check, only the king can move
    
    //Generating piece moves by going through set bits in that pieces' mask bitboards
    this.generateOrthogonalMoves(moves);
    this.generateDiagonalMoves(moves);
    this.generateKnightMoves(moves);
    this.generatePawnMoves(moves, board);
        
    return moves;
  }
  
  generateKingMoves(moves, board, onlyCaptures=false){
    const allowedMovesMask = ~(this.enemyAttacksMask | this.allyPieces.pieces);
    let kingMoves= BBUtil.kingMoves(this.allyKingSqr) & allowedMovesMask & this.capturesOnlyMask;
    
    while (kingMoves != 0n) {
      const targetSquare = BBUtil.getLSBIndex(kingMoves);
      moves.push(Move.newMove(this.allyKingSqr,targetSquare));
      kingMoves &= kingMoves - 1n;
    }
    
    //Castling can't be done when in check or if only generating captures
    if(this.inCheck || onlyCaptures) return;
    const blockers = this.enemyAttacksMask | this.allPieces;
    
    //King side
    if(board.hasCastleRight.kingSide[this.allyColor]){
      const castleMask=(this.allyColor==white) ? BBUtil.whiteKingSideMask : BBUtil.blackKingSideMask; 
      //If enemies don't attack and no pieces in the way, can castle
      if((blockers & castleMask) == 0n){
        const targetSquare=(this.allyColor==white) ? 62 : 6; //g1 or g8
        moves.push(Move.newMove(this.allyKingSqr,targetSquare, castleFlag));
      }
    }
    
    //Queen side
    if(board.hasCastleRight.queenSide[this.allyColor]){
      const castlePathMask=(this.allyColor==white) ? BBUtil.whiteQueenSideMaskPath : BBUtil.blackQueenSideMaskPath;
      const castleBlockersMask=(this.allyColor==white) ? BBUtil.whiteQueenSideMaskBlockers : BBUtil.blackQueenSideMaskBlockers; 
      //If enemies don't attack and no pieces in the way, can castle
      if((blockers & castlePathMask) == 0n && (this.allPieces & castleBlockersMask) == 0n){
        const targetSquare=(this.allyColor==white) ? 58 : 2; //c1 or c8
        moves.push(Move.newMove(this.allyKingSqr,targetSquare, castleFlag));
      }
    }
  }
  
  //Generates legal orthogonal moves (rooks & queens) for the color to move
  generateOrthogonalMoves(moves){
    let allyPieces=this.allyPieces.rooks | this.allyPieces.queens;
    if(this.inCheck) allyPieces &= ~this.pinRaysMask; //Pinned pieces can't move in check
    const allowedMovesMask = this.enemyOrEmptySqrs & this.checkRaysMask & this.capturesOnlyMask;
    
    while (allyPieces != 0n) {
      const startSquare = BBUtil.getLSBIndex(allyPieces);
      let movementMask = BBUtil.rookMoves(startSquare, this.allPieces) & allowedMovesMask; 
      //Limit pinned pieces movement to the ray they are pinned to
      if(this.isPinned(startSquare)) movementMask &= this.pinnedRays[startSquare];
      
      while(movementMask != 0){
        const targetSquare = BBUtil.getLSBIndex(movementMask);
        moves.push(Move.newMove(startSquare,targetSquare));
        movementMask &= movementMask - 1n;
      }
      allyPieces &= allyPieces - 1n;
    }
  }

  //Generates legal diagonal moves (bishops & queens) for the color to move
  generateDiagonalMoves(moves){
    let allyPieces=this.allyPieces.bishops | this.allyPieces.queens;
    if(this.inCheck) allyPieces &= ~this.pinRaysMask; //Pinned pieces can't move in check
    const allowedMovesMask = this.enemyOrEmptySqrs & this.checkRaysMask & this.capturesOnlyMask;
    
    while(allyPieces != 0n){
      const startSquare = BBUtil.getLSBIndex(allyPieces);
      let movementMask = BBUtil.bishopMoves(startSquare, this.allPieces) & allowedMovesMask;
      //Limit pinned pieces movement to the ray they are pinned to
      if(this.isPinned(startSquare)) movementMask &= this.pinnedRays[startSquare];
      
      while(movementMask != 0){
        const targetSquare = BBUtil.getLSBIndex(movementMask);
        moves.push(Move.newMove(startSquare,targetSquare));
        movementMask &= movementMask - 1n;
      }
      
      allyPieces &= allyPieces - 1n;
    }
  }
  
  //Generates legal knight moves for the color to move
  generateKnightMoves(moves){
    //Pinned knights can't move (can never capture the piece that pins them or maintain pin from a different square)
    //so we just don't generate their moves at all
    let allyKnights=this.allyPieces.knights & ~this.pinRaysMask;
    const allowedMovesMask = this.enemyOrEmptySqrs & this.checkRaysMask & this.capturesOnlyMask;
    
    while (allyKnights != 0n) {
      const startSquare = BBUtil.getLSBIndex(allyKnights);
      let movementMask = BBUtil.knightMoves(startSquare) & allowedMovesMask;
      
      while(movementMask != 0){
        const targetSquare = BBUtil.getLSBIndex(movementMask);
        moves.push(Move.newMove(startSquare,targetSquare));
        movementMask &= movementMask - 1n;
      }
      allyKnights &= allyKnights - 1n;
    }
  }
  
  //Generates legal pawn moves for the color to move
  generatePawnMoves(moves, board){
    let allyPawns=this.allyPieces.pawns;
    //Dir = -1 for white pawns (up) +1 for black pawns (down)
    const dir = (this.allyColor==white) ? -1 : 1;
    const moveOffset = 8*dir;
    const allowedMovesMask=this.emptySqrs & this.checkRaysMask & this.capturesOnlyMask;
    //Can only double push onto a specific rank depending on color
    const doublePushRank = (this.allyColor==white) ? BBUtil.rankMasks[4] : BBUtil.rankMasks[3];
    const promotionRank = (this.allyColor==white) ? BBUtil.rankMasks[0] : BBUtil.rankMasks[7];
    
    const singlePush = allyPawns << BigInt(moveOffset) & this.emptySqrs;
    //All pawns can move forward unless they are blocked
    let singlePushMask = singlePush & this.checkRaysMask & this.capturesOnlyMask;
    const doublePush = singlePush << BigInt(moveOffset);
    //All pawns that could do a single push can do a double unless blocked or not onto the allowed rank
    let doublePushMask = doublePush & doublePushRank & allowedMovesMask;
    
    //Single pushes
    while (singlePushMask != 0n) {
      const targetSquare = BBUtil.getLSBIndex(singlePushMask);
      const startSquare = targetSquare-moveOffset;
      //If the pawn is not pinned or maintains its pin after moving
      if(!this.isPinned(startSquare) || this.maintainsPin(startSquare,targetSquare)){
        //If the pawn lands on the promotion rank, generate promotion moves
        if(BBUtil.isBitSet(targetSquare, promotionRank)){
          this.generatePromotions(startSquare,targetSquare, moves);
        }else{
          moves.push(Move.newMove(startSquare,targetSquare));
        }
      }
      singlePushMask &= singlePushMask - 1n;
    }
    
    //Double pushes
    while (doublePushMask != 0n) {
      const targetSquare = BBUtil.getLSBIndex(doublePushMask);
      const startSquare = targetSquare-moveOffset*2;
      //If the pawn is not pinned or maintains its pin after moving
      if(!this.isPinned(startSquare) || this.maintainsPin(startSquare,targetSquare)){
        moves.push(Move.newMove(startSquare,targetSquare,pawnTwoMoveFlag));
      }
      doublePushMask &= doublePushMask - 1n;
    }
    
    //Captures
    while (allyPawns != 0n) {
      const startSquare = BBUtil.getLSBIndex(allyPawns);
      let attackMask = BBUtil.pawnAttacks(startSquare, this.allyColor);
      attackMask &= this.enemyPieces.pieces & this.checkRaysMask;
      
      while(attackMask != 0){
        const targetSquare = BBUtil.getLSBIndex(attackMask);
        //If the pawn is not pinned or maintains its pin after moving
        if(!this.isPinned(startSquare) || this.maintainsPin(startSquare,targetSquare)){
          //If the pawn lands on the promotion rank, generate promotion moves
          if(BBUtil.isBitSet(targetSquare, promotionRank)){
            this.generatePromotions(startSquare,targetSquare, moves);
          }else{
            moves.push(Move.newMove(startSquare,targetSquare));
          }
        }
        attackMask &= attackMask - 1n;
      }
      allyPawns &= allyPawns - 1n;
    }
    
    //En passant
    //Can't en passant if no en passant file is available this turn
    if(board.enPassantFile==undefined) return;
    
    const epFile = board.enPassantFile;
    const epRank = (this.allyColor==white) ? 2 : 5;
    
    //The square the ally pawn would end up in if it captured ep
    const targetSquare = BoardUtil.indexToSquare(epFile,epRank);
    //Square of the captured pawn
    const opponentPawnSquare = targetSquare-moveOffset;
    //Can't en passant if it doesn't stop check (block or capture)
    if(!BBUtil.isBitSet(opponentPawnSquare, this.checkRaysMask)) return;
    let candidateEnPassanters = BBUtil.pawnAttacks(targetSquare, this.enemyColor); //Squares next to the opponent pawn
    candidateEnPassanters &= this.allyPieces.pawns;
    
    while(candidateEnPassanters != 0){
      const startSquare = BBUtil.getLSBIndex(candidateEnPassanters);
      //If the pawn is not pinned or maintains its pin after moving
      if(!this.isPinned(startSquare) || this.maintainsPin(startSquare,targetSquare)){
        //If capturing en passant doesn't reveal a check on the ally king
        if(!this.inCheckIfEnPassant(startSquare, targetSquare, opponentPawnSquare))
        moves.push(Move.newMove(startSquare,targetSquare, enPassantFlag));
      }
      candidateEnPassanters &= candidateEnPassanters - 1n;
    } 
  }
  
  generatePromotions(startSquare, targetSquare, moves){
    moves.push(Move.newMove(startSquare,targetSquare,promoteKnightFlag));
    moves.push(Move.newMove(startSquare,targetSquare,promoteBishopFlag));
    moves.push(Move.newMove(startSquare,targetSquare,promoteRookFlag));
    moves.push(Move.newMove(startSquare,targetSquare,promoteQueenFlag));
  }
  
  //Determines if a piece maintains pin after moving
  //If the target square of the move intersects with the ray that pins it, it maintains the pin
  maintainsPin(startSquare,targetSquare){
    return BBUtil.isBitSet(targetSquare, this.pinnedRays[startSquare]);
  }
  
  //Calculates all the squares attacked by enemy sliders (including their own pieces)
  getEnemySlidingAttackMask(){
    const blockers=BBUtil.unsetBit(this.allyKingSqr, this.allPieces);
    let enemyDiagonals = this.enemyPieces.bishops | this.enemyPieces.queens;
    let enemyOrtho = this.enemyPieces.rooks | this.enemyPieces.queens;
    let enemySlidingAttacksMask=0n;
    
    //Diagonal sliders
    while(enemyDiagonals != 0n){
      const startSqr = BBUtil.getLSBIndex(enemyDiagonals);
      enemySlidingAttacksMask |= BBUtil.bishopMoves(startSqr,blockers);
      enemyDiagonals &= enemyDiagonals - 1n;
    }
    
    //Orthogonal sliders
    while(enemyOrtho != 0n){
      const startSqr = BBUtil.getLSBIndex(enemyOrtho);
      enemySlidingAttacksMask |= BBUtil.rookMoves(startSqr,blockers);
      enemyOrtho &= enemyOrtho - 1n;
    }
    return enemySlidingAttacksMask;
  }
  
  //Calculates all the squares attacked by enemy knights (including their own pieces)
  getEnemyKnightAttackMask(){
    let enemyKnights = this.enemyPieces.knights;
    let enemyKnightAttacksMask=0n;
    while(enemyKnights != 0n){
      const knightSqr = BBUtil.getLSBIndex(enemyKnights);
      const currKnightAttacks=BBUtil.knightMoves(knightSqr);
      enemyKnightAttacksMask |= currKnightAttacks;
      
      if((currKnightAttacks & this.allyPieces.king) != 0n){
        this.inDoubleCheck=this.inCheck; //If already in check, this is a double check
        this.inCheck=true;
        this.checkRaysMask=BBUtil.setBit(knightSqr,this.checkRaysMask);
      }
      
      enemyKnights &= enemyKnights - 1n;
    }
    return enemyKnightAttacksMask;
  }
  
  //Calculates all the squares attacked by enemy pawns (including their own pieces)
  getEnemyPawnAttackMask(){
    let enemyPawns = this.enemyPieces.pawns;
    let enemyPawnAttacksMask=0n;
    while(enemyPawns != 0n){
      const pawnSqr = BBUtil.getLSBIndex(enemyPawns);
      const currPawnAttacks=BBUtil.pawnAttacks(pawnSqr, this.enemyColor);
      enemyPawnAttacksMask |= currPawnAttacks;
      
      if((currPawnAttacks & this.allyPieces.king) != 0n){
        this.inDoubleCheck=this.inCheck; //If already in check, this is a double check
        this.inCheck=true;
        this.checkRaysMask=BBUtil.setBit(pawnSqr,this.checkRaysMask);
      }
      
      enemyPawns &= enemyPawns - 1n;
    }
    return enemyPawnAttacksMask;
  }
  
  //Calculates all the squares attacked by enemy king (including their own pieces)
  getEnemyKingAttackMask(){
    let enemyKing = this.enemyPieces.king;
    const kingSqr = BBUtil.getLSBIndex(enemyKing);
    const enemyKingAttacksMask = BBUtil.kingMoves(kingSqr);
    return enemyKingAttacksMask;
  }
  
  //Calculates whether the king is in check by an enemy sliding piece & pins on friendly pieces
  //Go over all 8 directions and determine the first 2 pieces on each of them
  calcAllyKingRays(board) {
    const startFile=BoardUtil.squareToFile(this.allyKingSqr);
    const startRank=BoardUtil.squareToRank(this.allyKingSqr);
    
    //Travel in all directions to find pieces (0-3 diagonal, 4-7 orthogonal)
    const directionOffsets = [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
    for (let i=0;i<directionOffsets.length;i++) {
      const dx = directionOffsets[i][0];
      const dy = directionOffsets[i][1];
      let allyBlockingRay=false;
      let allyBlockerSqr;
      let rayMask=0n;
      //Depending on the direction we are going, look for a certain enemy piece type to detect check
      const pieceToLookFor = (i>3) ? rook : bishop; //Bishops on diagonals & rooks on orthogonals
      
      let targetFile = startFile + dx;
      let targetRank = startRank + dy;
      
      //Go this direction until out of bounds
      while (BoardUtil.isValidSquare(targetFile, targetRank)) {
        const targetSquare = BoardUtil.indexToSquare(targetFile, targetRank);
        rayMask=BBUtil.setBit(targetSquare,rayMask); //Building rayMask square by square until out of bounds or 2 pieces found
        targetFile += dx;
        targetRank += dy;
        
        const pieceInSqr=board.piecesList[targetSquare];
        const pieceType=Piece.type(pieceInSqr);
        
        //No piece found in this square, keep going in this direction
        if(pieceType==none) continue;
        
        //Found ally piece, they could be pinned
        if(Piece.isColor(pieceInSqr, this.allyColor)){
          if(allyBlockingRay) break; //2 ally pieces were found, so no pin is possible in this direction
          allyBlockingRay=true;
          allyBlockerSqr=targetSquare;
          continue;
        }
        
        //Found enemy piece, check if they can attack on this direction (queens always can)
        if(pieceType==pieceToLookFor || pieceType==queen){
          if(allyBlockingRay){
            //Have previously found an ally piece (must be a pin)
            this.pinRaysMask |= rayMask;
            //Store the pin ray to limit ally piece's movements to it
            this.pinnedRays[allyBlockerSqr] = rayMask;
          }else{
            //No ally pieces blocking the attack, this is a check
            this.inDoubleCheck=this.inCheck; //If already in check, this is a double check
            this.inCheck=true;
            this.checkRaysMask |= rayMask;
          }
          break;
        }else{
          break; //The enemy piece doesn't deliver check so it blocks pins in this direction
        }
      }
      //Stop looking for pins and checks as only the king can move if it's in double check
      if(this.inDoubleCheck) break;
    }
  }
  
  //Returns true if the king would be in check if we were to perform an en passant capture
  //This happens when the opponent pawn is on the same rank as the king and covers a pin that goes undetected
  inCheckIfEnPassant(startSquare, targetSquare, opponentPawnSquare){
    const enemyOrtho = this.enemyPieces.rooks | this.enemyPieces.queens;
    //This can only happen with orthogonal pieces, so if none return false
    if(enemyOrtho==0n) return false;
    
    //"Simulating" the removal of the pawn that captured en passant and the pawn that was captured
    //Also simulates the ally pawn moving to its target square though not necessary
    const blockersAfterEp=this.allPieces ^ (1n<<BigInt(startSquare) | 1n<<BigInt(targetSquare) | 1n<<BigInt(opponentPawnSquare));
    
    //Generate rook moves from the king position with the blocker mask that ignores pawns involved in en passant
    const orthoAttacks = BBUtil.rookMoves(this.allyKingSqr, blockersAfterEp);
    
    //If the king can see an enemy orthogonal after en passant this would be a check
    return ((orthoAttacks & enemyOrtho) !=0)
  }
  
  //Returns true if the piece intersects with any pin ray mask
  isPinned(sqr){
    return ((this.pinRaysMask >> BigInt(sqr)) & 1n) != 0n;
  }
}