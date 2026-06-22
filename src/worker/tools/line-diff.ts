export interface LineChanges {
  addedLines: number;
  removedLines: number;
}

export interface LineDiffOptions {
  maxWork?: number;
}

const DEFAULT_MAX_WORK = 2_000_000;
const MAX_FRONTIER_LINES = 200_000;

function splitLogicalLines(content: string): string[] {
  if (!content) return [];
  return content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

function shortestEditDistance(
  oldLines: string[],
  newLines: string[],
  maxWork: number,
): number | undefined {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const maxDistance = oldLength + newLength;

  if (oldLength === 0) return newLength;
  if (newLength === 0) return oldLength;
  if (maxDistance > MAX_FRONTIER_LINES) return undefined;

  const offset = maxDistance + 1;
  const frontier = new Int32Array(maxDistance * 2 + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  let work = 0;

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      work += 1;
      if (work > maxWork) return undefined;

      const index = offset + diagonal;
      let oldIndex =
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
          ? frontier[index + 1]
          : frontier[index - 1] + 1;
      let newIndex = oldIndex - diagonal;

      while (
        oldIndex < oldLength &&
        newIndex < newLength &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        oldIndex += 1;
        newIndex += 1;
        work += 1;
        if (work > maxWork) return undefined;
      }

      frontier[index] = oldIndex;
      if (oldIndex >= oldLength && newIndex >= newLength) return distance;
    }
  }

  return undefined;
}

export function countLineChanges(
  oldContent: string,
  newContent: string,
  options: LineDiffOptions = {},
): LineChanges {
  const oldLines = splitLogicalLines(oldContent);
  const newLines = splitLogicalLines(newContent);
  let start = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;

  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) {
    start += 1;
  }
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const oldMiddle = oldLines.slice(start, oldEnd);
  const newMiddle = newLines.slice(start, newEnd);
  const configuredMaxWork = options.maxWork ?? DEFAULT_MAX_WORK;
  const maxWork =
    Number.isFinite(configuredMaxWork) && configuredMaxWork >= 0
      ? Math.floor(configuredMaxWork)
      : DEFAULT_MAX_WORK;
  const distance = shortestEditDistance(oldMiddle, newMiddle, maxWork);

  if (distance === undefined) {
    return {
      addedLines: newMiddle.length,
      removedLines: oldMiddle.length,
    };
  }

  return {
    addedLines: (distance + newMiddle.length - oldMiddle.length) / 2,
    removedLines: (distance + oldMiddle.length - newMiddle.length) / 2,
  };
}
