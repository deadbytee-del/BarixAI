// Myers O(ND) line diff + unified diff formatting/applying. Pure, dependency-free.
export function diffLines(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ t: " ", line: A[i] });
  for (const op of myers(A.slice(s, ea), B.slice(s, eb))) ops.push(op);
  for (let i = ea; i < A.length; i++) ops.push({ t: " ", line: A[i] });
  return ops;
}

function myers(a, b) {
  const N = a.length, M = b.length;
  if (!N) return b.map((line) => ({ t: "+", line }));
  if (!M) return a.map((line) => ({ t: "-", line }));
  const max = N + M;
  const trace = [];
  const v = new Map([[1, 0]]);
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)))
        ? (v.get(k + 1) ?? 0)
        : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= N && y >= M) break outer;
    }
  }
  // Backtrack (Coglan formulation). trace[d] is V as it was at the start of round d.
  const out = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const px = vv.get(prevK) ?? 0, py = px - prevK;
    while (x > px && y > py) { out.push({ t: " ", line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === px) out.push({ t: "+", line: b[y - 1] }); else out.push({ t: "-", line: a[x - 1] });
    }
    x = px; y = py;
  }
  return out.reverse();
}

export function diffStats(ops) {
  let add = 0, del = 0;
  for (const o of ops) { if (o.t === "+") add++; else if (o.t === "-") del++; }
  return { add, del };
}

export function unifiedDiff(a, b, { path = "file", context = 3 } = {}) {
  if (a === b) return "";
  const ops = diffLines(a, b);
  const changed = ops.map((o) => o.t !== " ");
  const ranges = [];
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue;
    const s = Math.max(0, i - context), e = Math.min(ops.length, i + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else ranges.push([s, e]);
  }
  let out = `--- a/${path}\n+++ b/${path}\n`;
  let la = 1, lb = 1, pos = 0;
  for (const [s, e] of ranges) {
    for (; pos < s; pos++) { if (ops[pos].t !== "+") la++; if (ops[pos].t !== "-") lb++; }
    let ca = 0, cb = 0;
    const body = [];
    for (let k = s; k < e; k++) {
      const o = ops[k];
      body.push(o.t + o.line);
      if (o.t !== "+") ca++;
      if (o.t !== "-") cb++;
    }
    out += `@@ -${ca ? la : la - 1},${ca} +${cb ? lb : lb - 1},${cb} @@\n${body.join("\n")}\n`;
    for (; pos < e; pos++) { if (ops[pos].t !== "+") la++; if (ops[pos].t !== "-") lb++; }
  }
  return out;
}

/** Apply a unified diff (single file). Throws with a precise reason if a hunk does not match. */
export function applyUnifiedDiff(text, patch) {
  const lines = text.split("\n");
  const out = [];
  let cursor = 0;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const pl = patch.split("\n");
  let i = 0;
  while (i < pl.length && !hunkRe.test(pl[i])) i++;
  while (i < pl.length) {
    const m = hunkRe.exec(pl[i]);
    if (!m) { i++; continue; }
    const at = +m[2] === 0 ? +m[1] : Math.max(0, +m[1] - 1);
    i++;
    const hunk = [];
    while (i < pl.length && !hunkRe.test(pl[i]) && !/^(---|\+\+\+) /.test(pl[i])) { hunk.push(pl[i]); i++; }
    while (hunk.length && hunk[hunk.length - 1] === "") hunk.pop();
    const before = hunk.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1));
    const pos = findSeq(lines, before, at, cursor);
    if (pos < 0) throw new Error(`hunk @@ -${m[1]} does not apply: expected context not found near line ${m[1]}`);
    while (cursor < pos) out.push(lines[cursor++]);
    for (const l of hunk) {
      if (l[0] === " ") out.push(lines[cursor++]);
      else if (l[0] === "-") cursor++;
      else if (l[0] === "+") out.push(l.slice(1));
    }
  }
  while (cursor < lines.length) out.push(lines[cursor++]);
  return out.join("\n");
}

function findSeq(lines, seq, hint, min) {
  if (!seq.length) return Math.max(hint, min);
  const ok = (p) => p >= min && p + seq.length <= lines.length && seq.every((s, k) => lines[p + k] === s);
  if (ok(hint)) return hint;
  for (let d = 1; d < lines.length; d++) { if (ok(hint - d)) return hint - d; if (ok(hint + d)) return hint + d; }
  return -1;
}
