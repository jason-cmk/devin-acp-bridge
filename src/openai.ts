import type { StopReason } from "@agentclientprotocol/sdk";

export type ChatContentPart = { type: string; text?: string; image_url?: { url?: string } };
export type ImageBlock = { type: "image"; mimeType: string; data: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage = {
  role: string;
  content: string | ChatContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ChatRequest = {
  model?: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  messages?: ChatMessage[];
  tools?: unknown[];
};

const TITLE_SYSTEM_PREFIX = "You name conversations";
const TITLE_WORD_LIMIT = 5;

export function messageText(message: ChatMessage | undefined): string {
  if (!message?.content) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s;

/** Images OpenCode attached as base64 data URLs. Devin accepts image prompt blocks (`promptCapabilities.image`). */
export function messageImages(message: ChatMessage | undefined): ImageBlock[] {
  if (!message || typeof message.content === "string" || !message.content) return [];
  return message.content.flatMap((part) => {
    const match = part.type === "image_url" ? part.image_url?.url?.match(DATA_URL) : undefined;
    return match ? [{ type: "image" as const, mimeType: match[1]!, data: match[2]! }] : [];
  });
}

export function lastUserText(request: ChatRequest): string {
  return messageText(request.messages?.findLast((message) => message.role === "user"));
}

export function isTitleRequest(request: ChatRequest): boolean {
  const system = request.messages?.find((message) => message.role === "system");
  return !request.tools?.length && messageText(system).startsWith(TITLE_SYSTEM_PREFIX);
}

/** OpenCode wraps the conversation's first message in `<message>` tags inside its title prompt. */
export function localTitle(request: ChatRequest): string {
  const prompt = lastUserText(request);
  const wrapped = prompt.match(/<message>\s*([\s\S]*?)\s*<\/message>/)?.[1] ?? prompt;
  const words = wrapped.replace(/^["']|["']$/g, "").split(/\s+/).filter(Boolean);
  return words.slice(0, TITLE_WORD_LIMIT).join(" ") || "Devin session";
}

export function finishReason(stopReason: StopReason): "stop" | "length" | "content_filter" {
  switch (stopReason) {
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

export type Delta = {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<ToolCall & { index: number }>;
};

export function offersTool(request: ChatRequest, name: string): boolean {
  return (request.tools ?? []).some((tool) => (tool as { function?: { name?: unknown } } | null)?.function?.name === name);
}

export function sseChunk(model: string, delta: Delta, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-devin",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

const NO_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

export function sseUsageChunk(model: string, usage: Usage = NO_USAGE): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-devin",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  })}\n\n`;
}

export function completion(model: string, content: string, finish: string, toolCalls?: ToolCall[]): object {
  return {
    id: "chatcmpl-devin",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
