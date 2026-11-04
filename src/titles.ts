import type { SessionUpdate } from "@agentclientprotocol/sdk";

/**
 * Devin's generated session title. Devin first sends the clipped prompt with `...` as a placeholder, then the
 * real title a few seconds later (§11.12); the placeholder is ignored.
 */
export function devinTitle(update: SessionUpdate, prompt: string): string | undefined {
  if (update.sessionUpdate !== "session_info_update") return undefined;
  const title = (update as { title?: unknown }).title;
  if (typeof title !== "string" || !title.trim()) return undefined;
  const head = title.trim().replace(/(\.\.\.|…)"?$/, "");
  return prompt.trim().startsWith(head) ? undefined : title.trim();
}

const KEEP_MS = 60_000;

/** Hands Devin's title to OpenCode's title request, which arrives at the same time as the first turn. */
export class TitleBoard {
  private readonly titles = new Map<string, { title: string; at: number }>();
  private readonly waiters = new Map<string, Array<(title: string) => void>>();

  offer(key: string, title: string): void {
    const waiters = this.waiters.get(key);
    this.waiters.delete(key);
    if (waiters) return waiters.forEach((resolve) => resolve(title));
    this.titles.set(key, { title, at: Date.now() });
    for (const [other, entry] of this.titles) if (Date.now() - entry.at > KEEP_MS) this.titles.delete(other);
  }

  wait(key: string, timeoutMs: number): Promise<string | undefined> {
    const early = this.titles.get(key);
    this.titles.delete(key);
    if (early) return Promise.resolve(early.title);
    return new Promise((resolve) => {
      const done = (title?: string) => {
        clearTimeout(timer);
        const rest = (this.waiters.get(key) ?? []).filter((waiter) => waiter !== done);
        if (rest.length) this.waiters.set(key, rest);
        else this.waiters.delete(key);
        resolve(title);
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.set(key, [...(this.waiters.get(key) ?? []), done]);
    });
  }

  clear(): void {
    this.titles.clear();
  }
}
