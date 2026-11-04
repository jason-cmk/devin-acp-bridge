import { createHash } from "node:crypto";
import { messageImages, messageText, type ChatMessage, type ChatRequest, type ImageBlock } from "./openai";

type Entry = { sessionId: string; userTurns: number };

export type SessionPlan =
  | { action: "reuse"; sessionId: string; prompt: string }
  | { action: "create"; prompt: string }
  | { action: "skip" };

const HARNESS_ONLY = /^\s*<(system-[a-z-]+)>[\s\S]*<\/\1>\s*$/;

/**
 * OpenCode adds user messages that hold only a `<system-reminder>` (plan agent) or `<system-update>` (its tool
 * catalog), and moves them between requests. They are harness text, not user turns: Devin has its own tools,
 * and its own plan mode replaces the reminder.
 */
export function isHarnessMessage(message: ChatMessage): boolean {
  return message.role === "user" && HARNESS_ONLY.test(messageText(message));
}

function conversationTurns(request: ChatRequest): ChatMessage[] {
  return (request.messages ?? []).filter((message) => (message.role === "user" || message.role === "assistant") && !isHarnessMessage(message));
}

export function latestUserText(request: ChatRequest): string {
  return messageText(conversationTurns(request).findLast((message) => message.role === "user"));
}

/** Images on the newest user message. Images on earlier messages are not replayed into a new session. */
export function latestUserImages(request: ChatRequest): ImageBlock[] {
  return messageImages(conversationTurns(request).findLast((message) => message.role === "user"));
}

/** After a reply, the plan agent sends one more request whose only new user messages are harness messages. */
function onlyHarnessSinceReply(request: ChatRequest): boolean {
  const messages = request.messages ?? [];
  const tail = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
  return tail.some(isHarnessMessage) && !tail.some((message) => message.role === "user" && !isHarnessMessage(message));
}

export function sessionKey(openCodeSession: string | null, request: ChatRequest, cwd: string): string {
  if (openCodeSession) return `opencode:${openCodeSession}`;
  const firstUser = messageText(conversationTurns(request).find((message) => message.role === "user"));
  return `hash:${createHash("sha256").update(cwd).update("\0").update(firstUser).digest("hex")}`;
}

function userTurns(request: ChatRequest): number {
  return conversationTurns(request).filter((message) => message.role === "user").length;
}

/** Replays the conversation for a fresh Devin session that has not seen the earlier turns. */
export function transcriptPrompt(request: ChatRequest): string {
  const turns = conversationTurns(request);
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
    latestUserText(request),
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
    if (onlyHarnessSinceReply(request)) return { action: "skip" };
    const turns = userTurns(request);
    const entry = this.entries.get(key);
    if (entry && turns === entry.userTurns + 1) return { action: "reuse", sessionId: entry.sessionId, prompt: latestUserText(request) };
    return { action: "create", prompt: turns > 1 ? transcriptPrompt(request) : latestUserText(request) };
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
