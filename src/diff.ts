type Op = { type: " " | "-" | "+"; line: string };

const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function middleOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map((line) => ({ type: "-" as const, line })), ...b.map((line) => ({ type: "+" as const, line }))];
  }
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ type: "-", line: a[i++]! });
    } else {
      ops.push({ type: "+", line: b[j++]! });
    }
  }
  while (i < a.length) ops.push({ type: "-", line: a[i++]! });
  while (j < b.length) ops.push({ type: "+", line: b[j++]! });
  return ops;
}

/** Unified diff hunks (no file header). Returns an empty list when the texts are equal. */
export function unifiedDiff(oldText: string, newText: string, context = 3, maxLines = 80): string[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const ops: Op[] = [
    ...a.slice(0, prefix).map((line) => ({ type: " " as const, line })),
    ...middleOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a.slice(a.length - suffix).map((line) => ({ type: " " as const, line })),
  ];

  const changed = ops.flatMap((op, index) => (op.type === " " ? [] : [index]));
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const output: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const [start, end] of ranges) {
    for (; cursor < start; cursor++) {
      if (ops[cursor]!.type !== "+") oldLine++;
      if (ops[cursor]!.type !== "-") newLine++;
    }
    const hunk = ops.slice(start, end + 1);
    const oldCount = hunk.filter((op) => op.type !== "+").length;
    const newCount = hunk.filter((op) => op.type !== "-").length;
    output.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    output.push(...hunk.map((op) => `${op.type}${op.line}`));
    for (; cursor <= end; cursor++) {
      if (ops[cursor]!.type !== "+") oldLine++;
      if (ops[cursor]!.type !== "-") newLine++;
    }
  }

  return output.length > maxLines
    ? [...output.slice(0, maxLines), `… ${output.length - maxLines} more diff lines`]
    : output;
}
