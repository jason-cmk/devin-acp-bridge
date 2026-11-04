import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "./diff";

describe("unifiedDiff", () => {
  test("returns no hunks for equal texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toEqual([]);
  });

  test("shows a one-line change with surrounding context", () => {
    expect(unifiedDiff("line one\nline two\nline three\n", "line one\nline 2\nline three\n")).toEqual([
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line 2",
      " line three",
    ]);
  });

  test("treats a missing old text as a new file", () => {
    expect(unifiedDiff("", "x\ny\n")).toEqual(["@@ -0,0 +1,2 @@", "+x", "+y"]);
  });

  test("splits distant changes into separate hunks with correct line numbers", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const after = before.replace("l2\n", "L2\n").replace("l19\n", "L19\n");
    expect(unifiedDiff(before, after, 1)).toEqual([
      "@@ -1,3 +1,3 @@",
      " l1",
      "-l2",
      "+L2",
      " l3",
      "@@ -18,3 +18,3 @@",
      " l18",
      "-l19",
      "+L19",
      " l20",
    ]);
  });

  test("truncates long diffs", () => {
    const after = Array.from({ length: 200 }, (_, i) => `n${i}`).join("\n");
    const lines = unifiedDiff("", after, 3, 10);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe("… 191 more diff lines");
  });
});
