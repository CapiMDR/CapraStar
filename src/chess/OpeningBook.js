//Initializes an opening repertoire for the bots to play

//Map from FEN -> list of book moves
let openingBook;

let bookEntries; //Loaded in preload from Book.txt

function loadBookMoveEntries(bookEntries) {
  // p5's loadStrings() returns an array of lines, whereas Node's
  // fs.readFileSync(..., "utf8") returns one string. Accept both so the
  // opening-book format is shared by the browser worker and the UCI adapter.
  const plainText = Array.isArray(bookEntries) ? bookEntries.join('\n') : String(bookEntries ?? '');
  
  const lines = plainText.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const book = {};
  let currentFEN = null;

  for (let l of lines) {
    if (l.startsWith('pos ')) {
      currentFEN = l.substring(4).trim();
      if (!(currentFEN in book)) {
        book[currentFEN] = [];
      }
    } else if (currentFEN) {
      //It's a move line, add it to the current FEN's move list
      book[currentFEN].push(l);
    }
  }

  return book;
}
