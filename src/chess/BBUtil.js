//Calculates & stores movement masks for all piece types. Also holds utility functions for BitBoards
class BBUtil {
  //Given a mask of moves with edges removed, returns all combinations of blocker pieces
  static generateBlockerMask(mask) {
    const variations = [];
    const maskSetBits = [];

    //Count bits set (1's) in the mask to create # of all blocker combinations
    for (let i = 0; i < 64; i++) if ((mask >> BigInt(i)) & 1n) maskSetBits.push(i);

    //Transform # of 1's in mask to decimal to know # of all possible
    //blocker combinations inside the mask
    const numVariations = 1 << maskSetBits.length; //(equivalent to 2^bits.length)

    //For every blocker combination
    for (let i = 0; i < numVariations; i++) {
      let blockerMask = 0n;
      //Go through the indeces with 1's in the masks[sqr]
      for (let j = 0; j < maskSetBits.length; j++) {
        //If currNumVariation (i) & currentSetBit (j) of the mask, build the blockerMask
        if (i & (1 << j)) blockerMask |= 1n << BigInt(maskSetBits[j]);
      }
      //For the current square, push the current blocker mask
      variations.push(blockerMask);
    }

    return variations;
  }

  static generateMagicData(isBishop = false) {
    //Since the method to generate magic bitboards for bishops and rooks is similar, both methods have been unified into this function
    const magics = isBishop ? bishopMagics : rookMagics; //Location of precomputed magic values
    const shifts = isBishop ? bishopShifts : rookShifts; //Location of precomputed shift values

    const data = {
      masks: [],
      magics: [],
      shifts: [],
      attacks: [],
      blockerAttacks: [],
    };

    //Depending on the piece type, the methods for mask & attack generation change
    const generateAttack = isBishop ? this.generateBishopAttack.bind(this) : this.generateRookAttack.bind(this);
    const generateMask = isBishop ? this.generateBishopMovesMask.bind(this) : this.generateRookMovesMask.bind(this);

    for (let sqr = 0; sqr < 64; sqr++) {
      const moveMask = generateMask(sqr);
      const blockerMasks = this.generateBlockerMask(moveMask);

      const magic = magics[sqr];
      const shift = shifts[sqr];
      const tableSize = 1 << BBUtil.countBits(moveMask);

      const attackTable = new Array(tableSize);
      const blockerAttacks = new Map();
      let hasCollision = false;
      for (const blockerMask of blockerMasks) {
        const index = this.magicIndex(blockerMask, magic, shift);
        //Precomputing all valid attack patterns based on all blocker combinations for all squares
        const attack = generateAttack(sqr, blockerMask);
        blockerAttacks.set(blockerMask, attack);

        //Some supplied magic values collide. Do not overwrite the previous
        //blocker configuration; keep the exact lookup as a safe fallback.
        if (attackTable[index] !== undefined && attackTable[index] !== attack) {
          hasCollision = true;
        } else {
          attackTable[index] = attack;
        }
      }

      data.masks[sqr] = moveMask;
      data.magics[sqr] = magic;
      data.shifts[sqr] = shift;
      data.attacks[sqr] = attackTable;
      data.blockerAttacks[sqr] = hasCollision ? blockerAttacks : null;
    }
    return data;
  }

  //Magic multiplication is a 64-bit operation. BigInt does not overflow on its
  //own, so mask the product to reproduce the required unsigned 64-bit wraparound.
  static magicIndex(blockers, magic, shift) {
    const product = (blockers * magic) & 0xffffffffffffffffn;
    return Number(product >> BigInt(64 - shift));
  }

  //Precomputes valid rook moves from a given square and mask of blocker pieces
  static generateRookAttack(sqr, blockers) {
    let attack = 0n;
    const startFile = BoardUtil.squareToFile(sqr);
    const startRank = BoardUtil.squareToRank(sqr);

    //Travel in orthogonal direction till a blocker is found
    const directions = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const [dx, dy] of directions) {
      let targetFile = startFile + dx;
      let targetRank = startRank + dy;
      while (BoardUtil.isValidSquare(targetFile, targetRank)) {
        const targetSquare = BoardUtil.indexToSquare(targetFile, targetRank);
        attack |= 1n << BigInt(targetSquare);
        if ((blockers >> BigInt(targetSquare)) & 1n) break; //Stop at blocker and change direction
        targetFile += dx;
        targetRank += dy;
      }
    }

    return attack;
  }

  //Precomputes valid bishop moves from a given square and mask of blocker pieces
  static generateBishopAttack(sqr, blockers) {
    let attack = 0n;
    const startFile = BoardUtil.squareToFile(sqr);
    const startRank = BoardUtil.squareToRank(sqr);

    //Travel in diagonal direction till a blocker is found
    const directions = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
    for (const [dx, dy] of directions) {
      let targetFile = startFile + dx;
      let targetRank = startRank + dy;
      while (BoardUtil.isValidSquare(targetFile, targetRank)) {
        const targetSquare = BoardUtil.indexToSquare(targetFile, targetRank);
        attack |= 1n << BigInt(targetSquare);
        if ((blockers >> BigInt(targetSquare)) & 1n) break; //Stop at blocker and change direction
        targetFile += dx;
        targetRank += dy;
      }
    }

    return attack;
  }

  //Generates bishop mask without edges for magic bitboard generation
  static generateBishopMovesMask(sqr) {
    //Offsets for bishop moves in files and ranks
    const moveDeltas = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
    let movesMask = 0n;

    const startFile = BoardUtil.squareToFile(sqr);
    const startRank = BoardUtil.squareToRank(sqr);

    for (const [dx, dy] of moveDeltas) {
      let targetFile = startFile + dx;
      let targetRank = startRank + dy;

      //While still inside board without edges
      while (targetFile > 0 && targetFile < 7 && targetRank > 0 && targetRank < 7) {
        movesMask = BBUtil.setBit(targetFile, targetRank, movesMask);
        targetFile += dx;
        targetRank += dy;
      }
    }

    return movesMask;
  }

  //Generates rook mask without edges for magic bitboard generation
  static generateRookMovesMask(sqr) {
    //Offsets for rook moves in files and ranks
    const moveDeltas = [
      [-1, 0],
      [0, -1],
      [0, 1],
      [1, 0],
    ];
    let movesMask = 0n;

    const startFile = BoardUtil.squareToFile(sqr);
    const startRank = BoardUtil.squareToRank(sqr);

    for (const [dx, dy] of moveDeltas) {
      let targetFile = startFile + dx;
      let targetRank = startRank + dy;

      //While still inside board without edges
      while ((dx != 0 && targetFile > 0 && targetFile < 7) || (dy != 0 && targetRank > 0 && targetRank < 7)) {
        movesMask = BBUtil.setBit(targetFile, targetRank, movesMask);
        targetFile += dx;
        targetRank += dy;
      }
    }

    return movesMask;
  }

  //Generating knight move bitboards (masks) for each square
  static generateKnightMoveMasks() {
    const masks = new Array(64).fill(0n);
    //Offsets for knight jumps in files and ranks
    const moveDeltas = [
      [1, 2],
      [2, 1],
      [2, -1],
      [1, -2],
      [-1, -2],
      [-2, -1],
      [-2, 1],
      [-1, 2],
    ];
    for (let sqr = 0; sqr < 64; sqr++) {
      let movesMask = 0n;

      const startFile = BoardUtil.squareToFile(sqr);
      const startRank = BoardUtil.squareToRank(sqr);

      for (const [dx, dy] of moveDeltas) {
        const targetFile = startFile + dx;
        const targetRank = startRank + dy;
        //Setting the bits of the move squares to 1
        movesMask = BBUtil.setBit(targetFile, targetRank, movesMask);
      }

      masks[sqr] = movesMask;
    }
    return masks;
  }

  //Generating king move bitboards (masks) for each square
  static generateKingMoveMasks() {
    const masks = new Array(64).fill(0n);
    for (let sqr = 0; sqr < 64; sqr++) {
      let movesMask = 0n;

      const startFile = BoardUtil.squareToFile(sqr);
      const startRank = BoardUtil.squareToRank(sqr);
      //Offsets for king moves in files and ranks
      for (let dx = -1; dx < 2; dx++) {
        for (let dy = -1; dy < 2; dy++) {
          if (dx == 0 && dy == 0) continue;
          const targetFile = startFile + dx;
          const targetRank = startRank + dy;
          movesMask = BBUtil.setBit(targetFile, targetRank, movesMask);
        }
      }

      masks[sqr] = movesMask;
    }
    return masks;
  }

  //Generating pawn attack bitboards (masks) for each square
  static generatePawnAttacksMasks(clr) {
    const dir = clr == white ? -1 : 1;
    const masks = new Array(64).fill(0n);
    for (let sqr = 0; sqr < 64; sqr++) {
      let movesMask = 0n;

      const startFile = BoardUtil.squareToFile(sqr);
      const startRank = BoardUtil.squareToRank(sqr);

      //Dir = -1 for white pawns (up) +1 for black pawns (down)
      movesMask = BBUtil.setBit(startFile - 1, startRank + 1 * dir, movesMask);
      movesMask = BBUtil.setBit(startFile + 1, startRank + 1 * dir, movesMask);

      masks[sqr] = movesMask;
    }
    return masks;
  }

  //Generating pawn move bitboards (masks) for each square (Not in use)
  static generatePawnMoveMasks(clr) {
    const dir = clr == white ? -1 : 1;
    const masks = new Array(64).fill(0n);
    for (let sqr = 0; sqr < 64; sqr++) {
      let movesMask = 0n;

      const startFile = BoardUtil.squareToFile(sqr);
      const startRank = BoardUtil.squareToRank(sqr);

      //Pawns can always move once
      //Dir = -1 for white pawns (up) +1 for black pawns (down)
      movesMask = BBUtil.setBit(startFile, startRank + 1 * dir, movesMask);

      //If in starting ranks, they can also move twice
      if (startRank == 1 || startRank == 6) movesMask = BBUtil.setBit(startFile, startRank + 2 * dir, movesMask);

      masks[sqr] = movesMask;
    }
    return masks;
  }

  //Get pawn moves mask from a square (Not in use)
  static pawnMoves(squareIndex, clr) {
    return clr == white ? this.whitePawnMoves_mask[squareIndex] : this.blackPawnMoves_mask[squareIndex];
  }

  //Get pawn attacks mask from a square
  static pawnAttacks(squareIndex, clr) {
    return clr == white ? this.whitePawnAttacks_mask[squareIndex] : this.blackPawnAttacks_mask[squareIndex];
  }

  //Get knight moves mask from a square
  static knightMoves(squareIndex) {
    return this.knightMoves_mask[squareIndex];
  }

  //Get valid bishop moves from a square given blockers BB
  static bishopMoves(sqr, occupancy) {
    const mask = this.bishopMagic.masks[sqr];
    const magic = this.bishopMagic.magics[sqr];
    const shift = this.bishopMagic.shifts[sqr];

    const occ = occupancy & mask;
    const blockerAttacks = this.bishopMagic.blockerAttacks[sqr];
    if (blockerAttacks) return blockerAttacks.get(occ);
    const index = this.magicIndex(occ, magic, shift);
    return this.bishopMagic.attacks[sqr][index];
  }

  //Get valid rook moves from a square given blockers BB
  static rookMoves(sqr, occupancy) {
    const mask = this.rookMagic.masks[sqr];
    const magic = this.rookMagic.magics[sqr];
    const shift = this.rookMagic.shifts[sqr];

    const occ = occupancy & mask;
    const blockerAttacks = this.rookMagic.blockerAttacks[sqr];
    if (blockerAttacks) return blockerAttacks.get(occ);
    const index = this.magicIndex(occ, magic, shift);
    return this.rookMagic.attacks[sqr][index];
  }

  //Get valid queen moves from a square given blockers BB
  static queenMoves(sqr, occupancy) {
    const rookAttacks = this.rookMoves(sqr, occupancy);
    const bishopAttacks = this.bishopMoves(sqr, occupancy);
    return rookAttacks | bishopAttacks; //If rook can reach or bishop can reach
  }

  //Get king moves mask from a square
  static kingMoves(squareIndex) {
    return this.kingMoves_mask[squareIndex];
  }

  //Get moves mask from given piece, square and blockers BB
  static getMoves(piece, squareIndex, blockersMask) {
    const type = Piece.type(piece);
    const clr = Piece.clr(piece);
    switch (type) {
      case pawn:
        return this.pawnMoves(squareIndex, clr); //(Not in use)
      case knight:
        return this.knightMoves(squareIndex);
      case bishop:
        return this.bishopMoves(squareIndex, blockersMask);
      case rook:
        return this.rookMoves(squareIndex, blockersMask);
      case queen:
        return this.queenMoves(squareIndex, blockersMask);
      case king:
        return this.kingMoves(squareIndex);
    }
    return 0n;
  }

  /*Utility methods*/
  //Sets a specific square to 1 on a given bitboard
  //If only 2 values are given, the file is taken as a square (0-63) and rank as a BB
  static setBit(file, rank, bitboard) {
    if (bitboard == undefined) return (rank |= 1n << BigInt(file));

    if (BoardUtil.isValidSquare(file, rank)) {
      return (bitboard |= 1n << BigInt(BoardUtil.indexToSquare(file, rank)));
    }
    return bitboard;
  }

  //Sets a specific square (file & rank) to 0 on a given bitboard
  //If only 2 values are given, the file is taken as a square (0-63) and rank as a BB
  static unsetBit(file, rank, bitboard) {
    if (bitboard == undefined) return (rank &= ~(1n << BigInt(file)));

    if (BoardUtil.isValidSquare(file, rank)) {
      return (bitboard &= ~(1n << BigInt(BoardUtil.indexToSquare(file, rank))));
    }
    return bitboard;
  }

  //Returns true if a given bit is set to 1 on a given bitboard
  static isBitSet(sqr, bitboard) {
    const targetBB = 1n << BigInt(sqr);
    return (bitboard & targetBB) != 0;
  }

  //Counts # of 1's in BB
  static countBits(bitboard) {
    let count = 0;
    while (bitboard) {
      count++;
      bitboard &= bitboard - 1n; // Clear the least significant 1 bit
    }
    return count;
  }

  //Toggles (inverts) 2 squares of a BB (0->1, 1->0)
  static toggleBits(sqr1, sqr2, bitboard) {
    return (bitboard ^= (1n << BigInt(sqr1)) | (1n << BigInt(sqr2)));
  }

  //Returns the index (0-63) of the least significant bit of a BitBoard using deBruijn method
  static getLSBIndex(bb) {
    if (bb === 0n) return -1; // No bits set
    const isolated = bb & -bb; // Isolate LSB
    const index = Number(((isolated * deBruijn64) >> 58n) & 63n); //Map to 0–63
    return deBruijnIndex[index];
  }

  //Prints BB in board format
  //visualFormat=true prints a standard board (ex: a1, e4)
  //visualFormat=false prints internal logic representation (ex: [0,7], [4,4])
  static printBB(bb, visualFormat = true) {
    const binaryStr = bb.toString(2).padStart(64, "0"); // 64-bit padded string
    for (let rank = 0; rank < 8; rank++) {
      let row = "";
      for (let file = 0; file < 8; file++) {
        const sqr = BoardUtil.indexToSquare(file, rank);
        row += binaryStr[63 - sqr] + " ";
      }
      console.log((visualFormat ? 8 - rank : rank) + "| " + row);
    }
    console.log(visualFormat ? "   A|B|C|D|E|F|G|H" : "   0|1|2|3|4|5|6|7");
    console.log(); // blank line for spacing
  }

  //Returns a mask of the squares in front of a square to detect passed pawns
  static passedPawnMask(sqr, clr) {
    const sqrRank = BoardUtil.squareToRank(sqr);
    const sqrFileIndex = BoardUtil.squareToFile(sqr);

    const midFileMask = BBUtil.fileMasks[sqrFileIndex];
    const leftFileMask = sqrFileIndex - 1 >= 0 ? BBUtil.fileMasks[sqrFileIndex - 1] : 0n;
    const rightFileMask = sqrFileIndex + 1 < 8 ? BBUtil.fileMasks[sqrFileIndex + 1] : 0n;
    const filesMask = leftFileMask | midFileMask | rightFileMask;

    //Returns mask going up if white
    if (clr == white) return filesMask >> BigInt(8 * (8 - sqrRank));
    //Returns mask going down if black
    //A bit more complicated since BigInts have weird wrap arounds so bit 0 gets set as overflow
    return (filesMask << BigInt(8 * (sqrRank + 1))) & ((1n << 64n) - 1n);
  }

  //Precomputes passed pawn masks for all squares and both colors
  static getPassedPawnMasks() {
    //Indexed by color (white/black) and square
    let passedPawnMasks = Array.from({ length: 2 }, () => Array(64).fill(0n));

    for (let sqr = 0; sqr < 64; sqr++) {
      passedPawnMasks[white][sqr] = this.passedPawnMask(sqr, white);
      passedPawnMasks[black][sqr] = this.passedPawnMask(sqr, black);
    }

    return passedPawnMasks;
  }
}

/*Static variables (regular static syntax for class properties doesn't work in p5 js)*/

//Precomputing move masks for every piece type for every square using MaGiC bItBoArDs
BBUtil.knightMoves_mask = BBUtil.generateKnightMoveMasks();

BBUtil.kingMoves_mask = BBUtil.generateKingMoveMasks();

//Pawn masks Dir = -1 for white pawns (up) +1 for black pawns (down)
BBUtil.whitePawnMoves_mask = BBUtil.generatePawnMoveMasks(white); //(Not in use)
BBUtil.blackPawnMoves_mask = BBUtil.generatePawnMoveMasks(black); //(Not in use)
BBUtil.whitePawnAttacks_mask = BBUtil.generatePawnAttacksMasks(white);
BBUtil.blackPawnAttacks_mask = BBUtil.generatePawnAttacksMasks(black);

//Castling masks for queen side and king side (must not be attacked or occupied)
//One queen mask is to stop the king from moving over check, the other is to detect all blockers between king and rook
BBUtil.whiteKingSideMask = 6917529027641081856n;
BBUtil.whiteQueenSideMaskPath = 864691128455135232n;
BBUtil.whiteQueenSideMaskBlockers = 1008806316530991104n;
BBUtil.blackKingSideMask = 96n;
BBUtil.blackQueenSideMaskPath = 12n;
BBUtil.blackQueenSideMaskBlockers = 14n;

BBUtil.fileMasks = [
  0x0101010101010101n, // File A
  0x0202020202020202n, // File B
  0x0404040404040404n, // File C
  0x0808080808080808n, // File D
  0x1010101010101010n, // File E
  0x2020202020202020n, // File F
  0x4040404040404040n, // File G
  0x8080808080808080n, // File H
];

BBUtil.rankMasks = [
  0x00000000000000ffn, // Rank 1
  0x000000000000ff00n, // Rank 2
  0x0000000000ff0000n, // Rank 3
  0x00000000ff000000n, // Rank 4
  0x000000ff00000000n, // Rank 5
  0x0000ff0000000000n, // Rank 6
  0x00ff000000000000n, // Rank 7
  0xff00000000000000n, // Rank 8
];

BBUtil.passedPawnMasks = BBUtil.getPassedPawnMasks();

BBUtil.rookMagic = {
  masks: [],
  magics: [],
  shifts: [],
  attacks: [],
};

BBUtil.bishopMagic = {
  masks: [],
  magics: [],
  shifts: [],
  attacks: [],
};

BBUtil.rookMagic = BBUtil.generateMagicData();
BBUtil.bishopMagic = BBUtil.generateMagicData(true);
