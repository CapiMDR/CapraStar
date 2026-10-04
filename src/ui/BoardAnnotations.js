let boardArrows = [];
let boardCircles = [];
let annotationDragStart;
let annotationDragPoint;

function clearBoardAnnotations() {
  boardArrows = [];
  boardCircles = [];
}

function beginBoardAnnotation(x, y) {
  const { currentFile, currentRank, currentSquare } = getCurrentMouseCoords(x, y);
  if (BoardUtil.outOfBounds(currentFile, currentRank)) return false;
  annotationDragStart = currentSquare;
  annotationDragPoint = { x, y };
  return true;
}

function updateBoardAnnotation(x, y) {
  if (annotationDragStart == undefined) return false;
  annotationDragPoint = { x, y };
  return false;
}

function finishBoardAnnotation(x, y) {
  if (annotationDragStart == undefined) return false;
  const { currentFile, currentRank, currentSquare } = getCurrentMouseCoords(x, y);
  if (!BoardUtil.outOfBounds(currentFile, currentRank)) {
    if (currentSquare === annotationDragStart) {
      const circleIndex = boardCircles.indexOf(currentSquare);
      if (circleIndex === -1) boardCircles.push(currentSquare);
      else boardCircles.splice(circleIndex, 1);
    } else {
      const arrowIndex = boardArrows.findIndex((arrow) => arrow.from === annotationDragStart && arrow.to === currentSquare);
      if (arrowIndex === -1) boardArrows.push({ from: annotationDragStart, to: currentSquare });
      else boardArrows.splice(arrowIndex, 1);
    }
  }
  annotationDragStart = undefined;
  annotationDragPoint = undefined;
  return false;
}

function annotationSquareCenter(square) {
  return {
    x: (adjustFile(BoardUtil.squareToFile(square)) + 0.5) * squareSize,
    y: (adjustRank(BoardUtil.squareToRank(square)) + 0.5) * squareSize,
  };
}

function drawBoardCircles() {
  if (!boardArrows || !boardCircles) return;

  push();
  const annotationColor = color(0, 220, 255);
  const lineWidth = Math.max(4, squareSize * 0.09);
  noFill();
  stroke(annotationColor);
  strokeWeight(lineWidth);
  for (const square of boardCircles) {
    const center = annotationSquareCenter(square);
    ellipse(center.x, center.y, squareSize * 0.7, squareSize * 0.7);
  }
  pop();
}

function drawBoardArrows() {
  if (!boardArrows) return;

  push();
  const annotationColor = color(0, 220, 255);
  const lineWidth = Math.max(4, squareSize * 0.09);
  noFill();
  stroke(annotationColor);
  strokeWeight(lineWidth);
  for (const { from, to } of boardArrows) drawArrow(from, to, annotationColor);
  if (annotationDragStart != undefined && annotationDragPoint) {
    drawPointerArrow(annotationSquareCenter(annotationDragStart), annotationDragPoint, annotationColor);
  }
  pop();
}

function drawPointerArrow(start, end, clr) {
  const { currentSquare: startSquare } = getCurrentMouseCoords(start.x, start.y);
  const { currentFile, currentRank, currentSquare: endSquare } = getCurrentMouseCoords(end.x, end.y);
  if (BoardUtil.outOfBounds(currentFile, currentRank) || startSquare === endSquare) return;
  drawArrow(startSquare, endSquare, clr);
}
