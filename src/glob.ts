/** Whole-string match where only `*` is special (matches anything, including nothing). */
export function globMatches(pattern: string, value: string | null | undefined): boolean {
  if (!value) return false;
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "s").test(value);
}
