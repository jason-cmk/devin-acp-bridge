import { createHash } from "node:crypto";
import { lastUserText, messageText, type ChatRequest } from "./openai";

type Entry = { sessionId: string; userTurns: number };

export type SessionPlan =
  | { action: "reuse"; sessionId: string; prompt: string }
  | { action: "create"; prompt: string };

export function sessionKey(openCodeSession: string | null, request: ChatRequest, cwd: string): string {
  if (openCodeSession) return `opencode:${openCodeSession}`;
  const firstUser = messageText(request.messages?.find((message) => message.role === "user"));
  return `hash:${createHash("sha256").update(cwd).update("\0").update(firstUser).digest("hex")}`;
}

function userTurns(request: ChatRequest): number {
  return request.messages?.filter((message) => message.role === "user").length ?? 0;
}

/** Replays the conversation for a fresh Devin session that has not seen the earlier turns. */
export function transcriptPrompt(request: ChatRequest): string {
  const turns = (request.messages ?? []).filter((message) => message.role === "user" || message.role === "assistant");
  const history = turns.slice(0, -1).map((message) => `[${message.role}]\n${messageText(message)}`).join("\n\n");
  return [
    "This conversation started in another session. Earlier turns:",
    "",
    "<conversation>",
    history,
    "</conversation>",
    "",
    "Continue the conversation by answering this latest user message:",
    "",
    lastUserText(request),
  ].join("\n");
}

/**
 * Maps OpenCode conversations to Devin sessions. A request that does not add exactly the next user turn means
 * OpenCode edited, retried or reverted history, or that the bridge restarted. Devin's session then no longer
 * matches, so the conversation moves to a fresh Devin session that receives the transcript.
 */
export class SessionStore {
  private readonly entries = new Map<string, Entry>();

  plan(key: string, request: ChatRequest): SessionPlan {
    const turns = userTurns(request);
    const entry = this.entries.get(key);
    if (entry && turns === entry.userTurns + 1) return { action: "reuse", sessionId: entry.sessionId, prompt: lastUserText(request) };
    return { action: "create", prompt: turns > 1 ? transcriptPrompt(request) : lastUserText(request) };
  }

  record(key: string, sessionId: string, request: ChatRequest): void {
    this.entries.set(key, { sessionId, userTurns: userTurns(request) });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
