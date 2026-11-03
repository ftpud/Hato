// Line diff between two in-memory texts, emitted as a Git-style unified patch that the native
// `diff` node parses. Common prefix/suffix are trimmed first so typical small edits are cheap;
// the middle uses Myers O(ND) with a bound, falling back to replace-all for huge rewrites.

type Op = { kind: " " | "-" | "+"; line: string };

function splitLines(text: string): { lines: string[]; noEol: boolean } {
  if (!text) return { lines: [], noEol: false };
  const noEol = !text.endsWith("\n");
  const lines = (noEol ? text : text.slice(0, -1)).split("\n");
  return { lines, noEol };
}

function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length, m = b.length, max = n + m, offset = max;
  // The trace keeps one vector per edit step; bound it to ~32 MB.
  maxD = Math.min(maxD, Math.floor(8_000_000 / (2 * max + 2)));
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const ops: Op[] = [];
        let cx = n, cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd], kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && pv[offset + kk - 1] < pv[offset + kk + 1]) ? kk + 1 : kk - 1;
          const px = pv[offset + prevK], py = px - prevK;
          while (cx > px && cy > py) { ops.push({ kind: " ", line: a[--cx] }); cy--; }
          if (cx === px) ops.push({ kind: "+", line: b[--cy] }); else ops.push({ kind: "-", line: a[--cx] });
        }
        while (cx > 0 && cy > 0) { ops.push({ kind: " ", line: a[--cx] }); cy--; }
        return ops.reverse();
      }
    }
  }
  return null;
}

export function diffLines(a: string[], b: string[], maxD = 4000): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const mid = myers(midA, midB, maxD) ?? [...midA.map(line => ({ kind: "-" as const, line })), ...midB.map(line => ({ kind: "+" as const, line }))];
  return [...a.slice(0, start).map(line => ({ kind: " " as const, line })), ...mid, ...a.slice(endA).map(line => ({ kind: " " as const, line }))];
}

/** `null` text means the file does not exist on that side. Returns "" when nothing changed. */
export function unifiedPatch(path: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return "";
  const header = [`diff --git a/${path} b/${path}`];
  if (before === null) header.push("new file mode 100644");
  if (after === null) header.push("deleted file mode 100644");
  header.push(before === null ? "--- /dev/null" : `--- a/${path}`, after === null ? "+++ /dev/null" : `+++ b/${path}`);
  const A = splitLines(before ?? ""), B = splitLines(after ?? "");
  // A last line without a trailing newline differs from the same text with one.
  const NO_EOL = "\u0000";
  const keyed = (s: { lines: string[]; noEol: boolean }) => s.noEol ? [...s.lines.slice(0, -1), s.lines[s.lines.length - 1] + NO_EOL] : s.lines;
  const ops = diffLines(keyed(A), keyed(B)).map(op => op.line.endsWith(NO_EOL) ? { ...op, line: op.line.slice(0, -1) } : op);
  const hunks: string[] = [];
  let i = 0, oldNo = 1, newNo = 1;
  const noEolAt = (op: Op, ai: number, bi: number) =>
    (op.kind !== "+" && A.noEol && ai === A.lines.length) || (op.kind !== "-" && B.noEol && bi === B.lines.length);
  while (i < ops.length) {
    if (ops[i].kind === " ") { i++; oldNo++; newNo++; continue; }
    // Hunk around the change at i, merging changes separated by <= 2*context unchanged lines.
    let from = i, lead = 0;
    while (from > 0 && lead < context && ops[from - 1].kind === " ") { from--; lead++; }
    let to = i;
    for (;;) {
      while (to < ops.length && ops[to].kind !== " ") to++;
      let gap = 0;
      while (to + gap < ops.length && ops[to + gap].kind === " ") gap++;
      if (to + gap < ops.length && gap <= 2 * context) { to += gap; continue; }
      to = Math.min(ops.length, to + Math.min(gap, context)); break;
    }
    const oStart = oldNo - lead, nStart = newNo - lead;
    let oCount = 0, nCount = 0, ai = oStart - 1, bi = nStart - 1;
    const body: string[] = [];
    for (let j = from; j < to; j++) {
      const op = ops[j];
      if (op.kind !== "+") { oCount++; ai++; }
      if (op.kind !== "-") { nCount++; bi++; }
      body.push(op.kind + op.line);
      if (noEolAt(op, ai, bi)) body.push("\\ No newline at end of file");
    }
    hunks.push(`@@ -${oCount ? oStart : oStart - 1},${oCount} +${nCount ? nStart : nStart - 1},${nCount} @@`, ...body);
    for (let j = i; j < to; j++) { if (ops[j].kind !== "+") oldNo++; if (ops[j].kind !== "-") newNo++; }
    i = to;
  }
  if (!hunks.length) return "";
  return [...header, ...hunks].join("\n") + "\n";
}
