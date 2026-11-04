import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { messageText, type ChatRequest, type ToolCall } from "./openai";
import { isHarnessMessage } from "./sessions";

/** The name and input shape of OpenCode's built-in `question` tool. */
export const QUESTION_TOOL = "question";
export type OpenCodeQuestion = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: true;
};

type FieldType = "string" | "number" | "integer" | "boolean" | "array";
type Field = { key: string; type: FieldType; labels: string[] };
export type QuestionForm = { fields: Field[]; questions: OpenCodeQuestion[] };

const HEADER_LIMIT = 30;
const ANSWER_PREFIX = "User has answered your questions: ";
const ANSWER_SUFFIX = ". You can now continue with the user's answers in mind.";
const UNANSWERED = "Unanswered";
const SEPARATOR = ", ";

type EnumEntry = string | { const?: unknown; title?: unknown };
type PropertySchema = {
  type?: string;
  title?: string | null;
  description?: string | null;
  enum?: EnumEntry[] | null;
  oneOf?: EnumEntry[] | null;
  anyOf?: EnumEntry[] | null;
  items?: { enum?: EnumEntry[] | null; oneOf?: EnumEntry[] | null; anyOf?: EnumEntry[] | null };
};

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function options(entries: EnumEntry[] | null | undefined): OpenCodeQuestion["options"] {
  return (entries ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [{ label: entry, description: "" }];
    if (typeof entry?.const !== "string") return [];
    const title = typeof entry.title === "string" && entry.title !== entry.const ? entry.title : "";
    return [{ label: entry.const, description: title }];
  });
}

function fieldOptions(schema: PropertySchema): OpenCodeQuestion["options"] {
  if (schema.type === "boolean") return options(["Yes", "No"]);
  if (schema.type === "array") return options(schema.items?.anyOf ?? schema.items?.oneOf ?? schema.items?.enum);
  return options(schema.oneOf ?? schema.enum);
}

/** Maps a form elicitation to OpenCode `question` tool input. Devin sends one string or array field per question. */
export function questionsFromElicitation(request: CreateElicitationRequest): QuestionForm | undefined {
  if (request.mode !== "form") return undefined;
  const properties = Object.entries(((request as { requestedSchema?: { properties?: Record<string, PropertySchema> } }).requestedSchema?.properties) ?? {});
  if (!properties.length) return undefined;
  const fields: Field[] = [];
  const questions = properties.map(([key, schema], index): OpenCodeQuestion => {
    const choices = fieldOptions(schema);
    const type = (["number", "integer", "boolean", "array"].includes(schema.type ?? "") ? schema.type : "string") as FieldType;
    fields.push({ key, type, labels: choices.map((choice) => choice.label) });
    return {
      question: schema.description || schema.title || request.message,
      header: clip(schema.title || `Question ${index + 1}`, HEADER_LIMIT),
      options: choices,
      ...(type === "array" ? { multiple: true as const } : {}),
    };
  });
  return { fields, questions };
}

export function questionToolCall(callId: string, form: QuestionForm): ToolCall {
  return { id: callId, type: "function", function: { name: QUESTION_TOOL, arguments: JSON.stringify({ questions: form.questions }) } };
}

/** The tool result text OpenCode's question tool returns to the model (`toModelContent` in OpenCode). */
export function answerText(questions: OpenCodeQuestion[], answers: string[][]): string {
  const formatted = questions.map((question, index) => `"${question.question}"="${answers[index]?.length ? answers[index].join(SEPARATOR) : UNANSWERED}"`);
  return `${ANSWER_PREFIX}${formatted.join(SEPARATOR)}${ANSWER_SUFFIX}`;
}

/** Splits a joined answer back into option labels; text that matches no label is one custom answer. */
function splitAnswer(value: string, labels: string[], multiple: boolean): string[] {
  if (value === UNANSWERED) return [];
  if (!multiple || labels.includes(value)) return [value];
  const parts = value.split(SEPARATOR);
  const answers: string[] = [];
  let custom: string[] = [];
  for (let start = 0; start < parts.length; ) {
    let end = parts.length;
    while (end > start && !labels.includes(parts.slice(start, end).join(SEPARATOR))) end--;
    if (end === start) {
      custom.push(parts[start++]!);
      continue;
    }
    if (custom.length) answers.push(custom.join(SEPARATOR));
    custom = [];
    answers.push(parts.slice(start, end).join(SEPARATOR));
    start = end;
  }
  if (custom.length) answers.push(custom.join(SEPARATOR));
  return answers;
}

/** Reads the answers out of OpenCode's question tool result, or returns undefined if the text is something else. */
export function parseAnswers(text: string, questions: OpenCodeQuestion[]): string[][] | undefined {
  if (!text.startsWith(ANSWER_PREFIX) || !text.endsWith(ANSWER_SUFFIX)) return undefined;
  const body = text.slice(ANSWER_PREFIX.length, text.length - ANSWER_SUFFIX.length);
  const answers: string[][] = [];
  let position = 0;
  for (const [index, question] of questions.entries()) {
    const opening = `"${question.question}"="`;
    if (!body.startsWith(opening, position)) return undefined;
    const start = position + opening.length;
    const next = questions[index + 1];
    const end = next ? body.indexOf(`"${SEPARATOR}"${next.question}"="`, start) : body.length - 1;
    if (end < start || (!next && body[end] !== '"')) return undefined;
    answers.push(splitAnswer(body.slice(start, end), question.options.map((option) => option.label), question.multiple === true));
    position = end + 1 + (next ? SEPARATOR.length : 0);
  }
  return answers;
}

function fieldValue(field: Field, answers: string[]): string | number | boolean | string[] | undefined {
  const first = answers[0];
  if (field.type === "array") return answers;
  if (first === undefined) return undefined;
  if (field.type === "boolean") return first === "Yes" ? true : first === "No" ? false : undefined;
  if (field.type === "number" || field.type === "integer") {
    const value = Number(first);
    return Number.isFinite(value) && (field.type === "number" || Number.isInteger(value)) ? value : undefined;
  }
  return first;
}

export function elicitationResponse(form: QuestionForm, answers: string[][]): CreateElicitationResponse {
  const content: Record<string, string | number | boolean | string[]> = {};
  form.fields.forEach((field, index) => {
    const value = fieldValue(field, answers[index] ?? []);
    if (value !== undefined) content[field.key] = value;
  });
  return { action: "accept", content };
}

/** The text of the tool result for `callId`, if the request ends with that result. OpenCode harness messages may follow it. */
export function toolResultText(request: ChatRequest, callId: string): string | undefined {
  const last = request.messages?.findLast((message) => !isHarnessMessage(message));
  return last?.role === "tool" && last.tool_call_id === callId ? messageText(last) : undefined;
}
