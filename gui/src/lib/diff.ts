/* Ronin Code — pure helpers for rendering unified diffs (unit-tested). */

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'context';

export interface DiffLine {
  text: string;
  kind: DiffLineKind;
}

/** Body lines of a unified diff (the ---/+++ header lines are dropped). */
export function parseDiffLines(diff: string): DiffLine[] {
  return diff
    .split('\n')
    .slice(2)
    .map((line) => ({
      text: line,
      kind: line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'del'
          : line.startsWith('@@')
            ? 'hunk'
            : 'context',
    }));
}
