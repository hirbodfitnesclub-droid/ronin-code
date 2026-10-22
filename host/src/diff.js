// Ronin Code — local host service.
// Pure unified-diff builder (LCS). No I/O — unit-tested directly.

export function unifiedDiff(oldText, newText, relPath) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > 1500 || b.length > 1500) return null;
  // LCS table
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = []; // {type:' '|'-'|'+', line}
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ t: " ", line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", line: a[i] }); i++; }
    else { ops.push({ t: "+", line: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ t: "-", line: a[i++] });
  while (j < b.length) ops.push({ t: "+", line: b[j++] });
  // Build hunks with 3 lines of context.
  const CTX = 3;
  const hunks = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].t === " ") { idx++; continue; }
    const start = Math.max(0, idx - CTX);
    let end = idx;
    let lastChange = idx;
    while (end < ops.length) {
      if (ops[end].t !== " ") lastChange = end;
      if (end - lastChange > CTX * 2 && ops[end].t === " ") break;
      end++;
    }
    end = Math.min(ops.length, lastChange + CTX + 1);
    const slice = ops.slice(start, end);
    const oldStart = ops.slice(0, start).filter((o) => o.t !== "+").length + 1;
    const newStart = ops.slice(0, start).filter((o) => o.t !== "-").length + 1;
    const oldCount = slice.filter((o) => o.t !== "+").length;
    const newCount = slice.filter((o) => o.t !== "-").length;
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) hunks.push(o.t + o.line);
    idx = end;
    if (hunks.length > 420) { hunks.push("…"); break; }
  }
  if (!hunks.length) return "";
  return `--- a/${relPath}\n+++ b/${relPath}\n${hunks.join("\n")}`;
}

// ---------- minimal ZIP writer (store/deflate, stdlib zlib) ----------
