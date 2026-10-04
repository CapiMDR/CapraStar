//Stockfish perft results (used for testing legal move generation & performance)
const stockfishResults = `
b3b4: 4515
d4d5: 5132
f6f7: 6710
g7g8q: 0
g7g8r: 0
g7g8b: 7018
g7g8n: 6336
d4e5: 2772
h3g4: 6466
a1c2: 7062
a8h1: 6594
a8g2: 6830
a8f3: 7292
a8e4: 6485
a8d5: 6849
a8c6: 7347
a8b7: 1644
d3b1: 6129
d3d1: 5976
d3f1: 6637
d3c2: 1849
d3d2: 5796
d3e2: 6942
d3c3: 1498
d3e3: 6764
d3f3: 6344
d3g3: 6126
d3c4: 1346
d3e4: 6158
d3b5: 5297
d3f5: 1425
d3a6: 737
d3g6: 5720
d3h7: 5450
d6e7: 6713
d6d5: 8044
d6e5: 4420
d6e6: 9240
`;

function perftDivide(board, depth) {
  const moveG = new MoveGenerator();
  const moves = moveG.generateMoves(board);

  let engineResultsMap = {};
  let total = 0;

  for (const move of moves) {
    board.makeMove(move);
    const count = perft(board, depth - 1);
    board.unmakeMove(move);

    const moveStr = Move.toString(move);
    engineResultsMap[moveStr] = count;
    total += count;
  }
  return engineResultsMap;
}

function perft(board, depth) {
  const moveG = new MoveGenerator();
  const moves = moveG.generateMoves(board);
  let nodes = 0;
  if (depth == 0) return 1;

  for (let move of moves) {
    board.makeMove(move);
    nodes += perft(board, depth - 1);
    board.unmakeMove(move);
  }
  return nodes;
}

//Transforms results from string to map for easy comparison
function mapResults(results) {
  const lines = results.trim().split("\n");
  const perftMap = {};
  for (const line of lines) {
    if (line == "") continue;
    const [move, countStr] = line.split(":");
    perftMap[move.trim()] = parseInt(countStr.trim(), 10);
  }
  return perftMap;
}

//Compares results from perft with the ones given by stockfish
function compareOutputs(engineResults, stockfishResults) {
  let mismatchCount = 0;
  const allMoves = new Set([...Object.keys(engineResults), ...Object.keys(stockfishResults)]);

  for (const move of allMoves) {
    const engineCount = engineResults[move] ?? 0;
    const sfCount = stockfishResults[move] ?? 0;

    if (engineCount !== sfCount) {
      console.log("❌ Mismatch: " + move + " | Engine: " + engineCount + " | Stockfish: " + sfCount);
      mismatchCount++;
    } else {
      console.log("✅ " + move + " | " + engineCount);
    }
  }

  const totalEngine = Object.values(engineResults).reduce((a, b) => a + b, 0);
  const totalStockfish = Object.values(stockfishResults).reduce((a, b) => a + b, 0);
  console.log("\n---- SUMMARY ----");
  console.log("Engine total: " + totalEngine);
  console.log("Stockfish total: " + totalStockfish);
  console.log("Mismatches: " + mismatchCount);
}

/*Magic number generation + testing*/

//Used to guarantee no collisions occur with magic number and shift values on any square
function testAllSlidingMoves(isBishop = false) {
  const masks = isBishop ? BBUtil.bishopMagic.masks : BBUtil.rookMagic.masks;
  const generateAttack = isBishop ? BBUtil.generateBishopAttack.bind(BBUtil) : BBUtil.generateRookAttack.bind(BBUtil);
  const getMoves = isBishop ? BBUtil.bishopMoves.bind(BBUtil) : BBUtil.rookMoves.bind(BBUtil);

  let counter = 0;

  for (let sq = 0; sq < 64; sq++) {
    const mask = masks[sq];
    const blockersList = BBUtil.generateBlockerMask(mask);
    for (const blockers of blockersList) {
      const expected = generateAttack(sq, blockers);
      const actual = getMoves(sq, blockers);
      if (expected !== actual) {
        console.error(`Mismatch at square ${sq} with blockers: ${blockers.toString()}`);
        console.log("Expected:");
        BBUtil.printBB(expected);
        console.log("Got:     ");
        BBUtil.printBB(actual);
        counter++;
      }
    }
  }
  console.log("All " + (isBishop ? "bishop" : "rook") + " moves validated successfully.");
  console.log("Wrong: " + counter);
}

//Generator function for magic numbers and their corresponding shift values
function findMagicNumber(sqr, isBishop = false, maxTries = 1000) {
  const generateMask = isBishop ? BBUtil.generateBishopMovesMask.bind(BBUtil) : BBUtil.generateRookMovesMask.bind(BBUtil);
  const generateAttack = isBishop ? BBUtil.generateBishopAttack.bind(BBUtil) : BBUtil.generateRookAttack.bind(BBUtil);

  const mask = generateMask(sqr);
  const blockerPermutations = BBUtil.generateBlockerMask(mask);
  const numBits = BBUtil.countBits(mask);

  const shift = 64 - numBits;
  const size = 1 << numBits;

  const attackMap = new Map();
  for (let blockers of blockerPermutations) {
    const attack = generateAttack(sqr, blockers);
    attackMap.set(blockers.toString(), attack);
  }

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const candidate = generateRandomMagic();
    const used = new Array(size).fill(undefined);
    let collision = false;

    for (let blockers of blockerPermutations) {
      const index = BBUtil.magicIndex(blockers, candidate, numBits);
      const attack = attackMap.get(blockers.toString());

      if (used[index] === undefined) {
        used[index] = attack;
      } else if (used[index] !== attack) {
        collision = true;
        break;
      }
    }

    if (!collision) {
      console.log(`Found magic for square ${sqr}: ${candidate.toString(16)}`);
      return sqr + " " + candidate + " " + shift;
    }
  }

  console.warn(`Failed to find magic number for square ${sqr} after ${maxTries} attempts`);
  return undefined;
}

function generateRandomMagic() {
  return rand64() & rand64() & rand64();
}

/*Seeded random 64 bit number generator*/
function createRand64(seed) {
  const rng = mulberry32(seed);

  return function rand64() {
    const high = BigInt(Math.floor(rng() * 0x100000000)); // Upper 32 bits
    const low = BigInt(Math.floor(rng() * 0x100000000)); // Lower 32 bits
    return (high << 32n) | low;
  };
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/*---------------------------------------------------------------------------*/
//LIST OF MIRRORED FEN FOR TESTING SYMMETRICAL EVALUATION
//8/Kpb3n1/3Ppk2/1RQ5/1Rp3P1/6qb/2p4n/8 w - - 0 1
//8/N4P2/BQ6/1p3Pr1/5qr1/2KPp3/1N3BPk/8 b - - 0 1

//r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq -
//r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq -

//r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -
//rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/2N5/PPPP1PPP/R1BQK1NR b KQkq -

/*---------------------------------------------------------------------------*/
//INTERESTING POSITIONS:
//B5k1/p3qpbp/2p3p1/4p3/4n3/1P6/1P3PPP/R1B1R1K1 w - - 0 43 (taking knight is best move)

/*---------------------------------------------------------------------------*/
//KNOWN BUGS:
/*
H8 square magic bitboard has collisions (band-aid fix implemented):
"r6r/Ppppkppp/1b3nb1/nPP5/BB2P1N1/q4N2/Pp1P2PP/R2Q1RK1 b - - 2 2"
Rook h8b8 not possible when any piece on h file (magic bitboard issue)
^^ FIXED ^^

Engine doesn't see mate in 4 until it is too late
r2q1rk1/pb2npb1/3p2p1/1ppPp2p/4P1PP/1P1P4/PB1QNPB1/R3K2R b KQ - 0 1
h5g4 
e2g3 
g7f6 
h4h5 
f8e8 
h5g6 
e7g6 
d2h6 
g6h4 
g3f5 
h4g2 
e1f1 
g2e3 
f2e3 
d8d7 
h6h7 
g8f8 
h7h8 
f6h8 
h1h8 
*/

/*
Game I (white) won against CapraStar 8 (black)
1-e2e4 c7c6
2-d2d4 d7d6
3-b1c3 d8c7
4-g1f3 b8d7
5-c1e3 g8f6
6-f1d3 e7e5
7-e1g1 f8e7
8-f1e1 e8g8
9-h2h3 d6d5
10-e4d5 f6d5
11-c3d5 c6d5
12-d4e5 d7e5
13-f3e5 c7e5
14-e3a7 e5b2
15-a7e3 a8a2
16-a1a2 b2a2
17-d1h5 g7g6
18-h5e5 a2a5
19-e3h6 a5e1
20-e5e1 e7f6
21-h6f8 g8f8
22-e1a5 c8e6
23-a5a8 f8g7
24-a8b7 h7h5
25-f2f3 f6d4
26-g1f1 g7f6
27-b7a6 d4e5
28-d3b5 h5h4
29-b5d7 g6g5
30-d7e6 f7e6
31-f1e2 f6f5
32-e2d3 e5g7
33-a6c6 g7e5
34-c6e8 e5f6
35-d3e3 f6e5
36-e8c6 e5f6
37-c2c4 d5d4
38-e3d3 e6e5
39-c6e4 f5e6
40-c4c5 e6e7
41-c5c6 e7d6
42-d3c4 d6c7
43-c4b5 f6g7
44-e4h7 c7d6
45-h7g7 d6e6
46-g7g5 d4d3
47-g5h4 e6f7
48-h4h6 d3d2
49-h6d2 f7g6
50-c6c7 e5e4
51-c7c8q e4e3
52-d2d3 g6g7
53-c8d7 g7f8
54-d3f5 f8g8
55-d7f7 g8h8
56-f5h7

1-e2e4 g8f6
2-b1c3 d7d5
3-e4e5 f6e4
4-d2d3 e4c3
5-b2c3 b8c6
6-d3d4 f7f6
7-g1f3 f6e5
8-f3e5 c6e5
9-d4e5 e7e6
10-f1b5 e8f7
11-d1f3 f7g8
12-e1g1 a7a6
13-b5d3 f8c5
14-a1b1 d8d7
15-c3c4 d5d4
16-d3e4 d7a4
17-f3b3 a4b3
18-b1b3 a8b8
19-f1d1 c5a7
20-c2c3 d4d3
21-d1d3 g8f7
22-c1g5 a7b6
23-g1f1 h7h6
24-g5h4 g7g5
25-h4g3 h6h5
26-h2h4 g5g4
27-b3b1 b6c5
28-b1d1 h8f8
29-f2f3 f7e7
30-e4g6 f8h8
31-f3g4 h5g4
32-f1e2 a6a5
33-d1f1 h8f8
34-f1f8 e7f8
35-h4h5 b7b6
36-d3d8 f8g7
37-g3f4 c5e7
38-d8e8 e7c5
39-f4g5 c8a6
40-e8b8 a6c4
41-e2d2 c5f8
42-g5f6 g7g8
43-h5h6 a5a4
44-h6h7  
*/

/*
CapraStar 8 (black) loses against https://yandex.com/games/app/371648#app-id=371648& bot (white)
1-b1c3 g8f6
2-g1f3 e7e6
3-e2e4 d7d5
4-e4e5 f6d7
5-d2d4 c7c5
6-f1b5 a7a6
7-b5a4 c5d4
8-d1d4 b8c6
9-a4c6 b7c6
10-e1g1 c6c5
11-d4a4 f8e7
12-a4g4 e8f8
13-f1e1 d8b6
14-a1b1 d5d4
15-c3e2 h7h6
16-c1f4 c8b7
17-b2b4 c5b4
18-e2d4 b6c7
19-g4e6 b7f3
20-g2f3 c7c8
21-e6d5 d7b6
22-d5e4 c8c4
23-d4c6 a6a5
24-a2a3 e7c5
25-a3b4 a5b4
26-c6b4 a8d8
27-b4d3 d8d4
28-e4b7 c4c2
29-d3c5 d4f4
30-b7b8 f8e7
31-b8c7 e7e8
32-b1b6 c2g6
33-b6g6 f4d4
34-g6d6 d4d6
35-e5d6 e8f8
36-c7c8

CapraStar 8 (white) finds draw against https://yandex.com/games/app/371648#app-id=371648& bot (black)
1-d2d4 g8f6
2-c1f4 b8c6
3-e2e3 f6d5
4-f4g3 e7e6
5-b1d2 d5f6
6-g1f3 d7d5
7-f1b5 c8d7
8-e1g1 f8d6
9-g3d6 c7d6
10-d1e2 d8b6
11-a2a3 a7a6
12-b5c6 d7c6
13-e2d3 e8g8
14-a1b1 a8e8
15-d3c3 f6e4
16-c3d3 e6e5
17-h2h3 e4f6
18-d3b3 b6a5
19-b1d1 e5e4
20-f3h4 c6a4
21-b3b7 a4c2
22-h4f5 c2d1
23-f1d1 e8b8
24-b7c6 b8b2
25-f5e7 g8h8
26-c6d6 b2d2
27-d1d2 a5d2
28-e7d5 d2d1
29-g1h2 f8a8
30-d5f6 g7f6
31-d6f6 h8g8
32-f6g5 g8f8
33-g5c5 f8g7
34-c5g5 g7h8
35-g5f6 h8g8
36-f6g5 g8f8
37-g5c5 f8g8
38-c5g5

1-e2e4 e7e6
2-b1c3 g8f6
3-e4e5 f6d5
4-c3d5 e6d5
5-d2d4 d7d6
6-g1f3 d6e5
7-f3e5 b8d7
8-d1h5 d7e5
9-h5e5 c8e6
10-f1d3 d8d6
11-e1g1 d6e5
12-d4e5 f8c5
13-c1f4 e8g8
14-a2a3 d5d4
15-b2b4 c5e7
16-d3e4 f8b8
17-f1d1 g7g5
18-f4c1 f7f5
19-e4d3 f5f4
20-h2h4 b8e8
21-d3e4 e8d8
22-h4g5 e6g4
23-f2f3 g4e6
24-c1f4 a8b8
25-f4d2 d8d7
26-f3f4 e6c4
27-f4f5 b8f8
28-f5f6 e7d8
29-e4f5 d7f7
30-d2f4 c7c5
31-b4c5 f7c7
32-d1d4 c4b5
33-a1d1 b5e2
34-f5e6 c7f7
35-e6f7 g8f7
36-d4d7 f7g8
37-d7g7 g8h8
38-d1d7 d8f6
39-g5f6 e2a6
40-g7h7 h8g8
41-d7g7


1-d2d4 f7f5
2-g1f3 g7g6
3-e2e3 g8f6
4-c2c4 d7d5
5-b1c3 b8c6
6-c4d5 f6d5
7-f1c4 d5c3
8-b2c3 f8g7
9-d1b3 e7e5
10-c4f7 e8e7
11-c1a3 e7f6
12-d4e5 c6e5
13-a1d1 e5f7
14-d1d8 f7d8
15-e1g1 d8e6
16-f1d1 a7a5
17-f3d4 a5a4
18-b3b1 h8d8
19-d4e6 d8d1
20-b1d1 c8e6
21-d1c2 e6d5
22-a3c5 g7h6
23-a2a3 b7b5
24-c5d4 f6e6
25-g1f1 h6f8
26-c2b2 d5c4
27-f1e1 c7c5
28-d4c5 f8c5
29-e1d2 a8d8
30-d2c2 c4b3
31-c2c1 d8d1

Me (white) vs CapraStar 8b (black) draw by repetition
1-d2d4 e7e6
2-c2c4 d7d5
3-c4d5 e6d5
4-b1c3 f7f5
5-c1f4 b8c6
6-g1f3 a7a6
7-a2a3 g8e7
8-e2e3 e7g6
9-f4g3 f8d6
10-f1d3 d6g3
11-h2g3 c8e6
12-d1c2 e8g8
13-e1c1 d8d6
14-h1h2 h7h6
15-c2b3 c6a5
16-b3c2 g6e7
17-f3e5 a5c6
18-f2f4 a8b8
19-h2h1 f8d8
20-h1h5 d8e8
21-d1h1 c6e5
22-f4e5 d6c6
23-c1b1 b8d8
24-h1f1 e8f8
25-f1c1 d8e8
26-c1f1 f8f7
27-h5h1 e8d8
28-d3e2 f7f8
29-f1f4 d8b8
30-e2d1 b8e8
31-c2d3 c6b6
32-d1c2 e7g6
33-f4f1 e8d8
34-g3g4 g6e7
35-h1h5 e6f7
36-h5h1 f7e6
37-h1h5 e6f7
38-h5h1 f7e6

Another game I (white) won against CapraStar (black)
1-d2d4 g8f6
2-g1f3 e7e6
3-e2e3 b7b6
4-f1d3 c8b7
5-b1d2 f8e7
6-d1e2 b8c6
7-c2c3 d7d5
8-e1g1 e8g8
9-e3e4 d5e4
10-d2e4 d8d5
11-f1e1 f6e4
12-d3e4 d5d6
13-g2g3 a8b8
14-c1f4 d6d7
15-a2a4 e7d6
16-e2e3 h7h6
17-a1d1 b8d8
18-f3e5 d6e5
19-d4e5 d7d1
20-e1d1 d8d1
21-g1g2 c6a5
22-e4b7 a5b7
23-e3f3 d1b1
24-f3b7 g7g5
25-f4e3 b1b2
26-b7c7 f8a8
27-e3d4 b2a2
28-c7d7 g5g4
29-d4e3 h6h5
30-d7e7 a2a4
31-e7g5 g8f8
32-g5h5 f8g8
33-e3g5 a4f4
34-g5f4 a8b8
35-h5g5 g8f8
36-g5g4 a7a5
37-g4h5 f8g8
38-f4h6 g8h7
39-h6g5 h7g8
40-g5f6 b8e8
41-h5h8

CapraStar 9 destroys me
d2d4 e7e5
d4e5 f7f6
e5f6 g8f6
b1c3 d7d5
g1f3 f8b4
c1d2 e8g8
e2e3 b8c6
f1e2 c8f5
e1g1 b4c5
c3a4 c5e7
d2c1 d8d6
b2b3 f6e4
c1b2 e7f6
f3d4 c6d4
e3d4 f8e8
f1e1 d6f4
f2f3 f4e3
g1h1 e4f2
h1g1 f2h3
g1h1 e3g1
e1g1 h3f2

Me (black) vs whatever version is in my chess website (white) (draw)
1. e4 c5 2. c3 Nc6 3. f4 g6 4. d3 Bg7 5. Nd2 d6 6. Ngf3 Nf6 7. Be2 Bg4 8. h3 Bxf3 9. Bxf3 O-O 10. e5 dxe5 11. Bxc6 bxc6 12. fxe5 Nd7 13. d4 cxd4 14. cxd4 c5 15. d5 Nxe5 16. Ne4 Rb8 17. Kf1 c4 18. Qd4 Qb6 19. Qxb6 axb6 20. Bg5 f6 21. Bf4 f5 22. Ng5 Rfd8 23. Rd1 Nd3 24. Bxb8 Rxb8 25. b3 b5 26. Ne6 Bb2 27. Ke2 Nb4 28. bxc4 bxc4 29. a4 c3 30. Nf4 c2 31. Rde1 Ra8 32. Nd3 Nxd3 33. Kxd3 c1=Q 34. Rxc1 Bxc1 35. Rxc1 Rxa4 36. Rc7 Kf8 37. Rc8+ Kf7 38. Rc7 Ke8 39. Ke3 Re4+ 40. Kd3 Ra4 41. Ke3 Re4+
*/

/*
//chess = new Engine("8/2KP4/8/8/8/8/6q1/7k b - - 0 1"); //End game test
//chess = new Engine("r5rk/pp1b1p1p/1qn1pPpQ/5nPP/5P2/1PP5/2B5/R1B1K2R w KQ - 0 1"); //Mate in 3 test
//chess = new Engine("2q1nk1r/4Rp2/1ppp1P2/6Pp/3p1B2/3P3P/PPP1Q3/6K1 w"); //Mate in 5
//chess = new Engine("6r1/p3p1rk/1p1pPp1p/q3n2R/4P3/3BR2P/PPP2QP1/7K w"); //Mate in 7
//chess = new Engine("8/3PK3/2q5/8/8/8/8/7k b - - 0 1"); //End game test
//chess = new Engine("8/6p1/5k2/8/8/1K6/8/8 b - - 0 1"); //End game test
//console.log(findMagicNumber(7,false));
//testAllSlidingMoves(false);
*/
