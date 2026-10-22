import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiffLines } from '../src/lib/diff.ts';

test('parseDiffLines drops the ---/+++ headers and classifies lines', () => {
  const diff = ['--- a/x.txt', '+++ b/x.txt', '@@ -1,2 +1,2 @@', ' same', '-old', '+new'].join('\n');
  const lines = parseDiffLines(diff);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['hunk', 'context', 'del', 'add'],
  );
  assert.deepEqual(
    lines.map((l) => l.text),
    ['@@ -1,2 +1,2 @@', ' same', '-old', '+new'],
  );
});

test('parseDiffLines on an empty diff yields no body lines', () => {
  assert.deepEqual(parseDiffLines(''), []);
});

test('parseDiffLines keeps blank context lines as context', () => {
  const diff = ['--- a', '+++ b', ''].join('\n');
  assert.deepEqual(parseDiffLines(diff), [{ text: '', kind: 'context' }]);
});
