import Anthropic from "@anthropic-ai/sdk";
import type { CallInterpretation, CallInterpreter } from "../types.ts";

export interface ClaudeInterpreterOptions {
  client?: Anthropic;
  model?: string;
}

const SYSTEM_PROMPT = [
  "You prepare context for an automated phone call router.",
  "The user message contains speech-to-text transcripts of one caller, one line per attempt, and may contain recognition errors.",
  "Write one or two short sentences describing what the caller wants and any urgency they expressed.",
  "Leave out personal details: names, phone numbers, addresses, account numbers, card numbers, dates of birth.",
  "If the caller's request is unclear, state that it could not be determined.",
].join(" ");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

export function createClaudeInterpreter(options: ClaudeInterpreterOptions = {}): CallInterpreter {
  const client = options.client ?? new Anthropic({ maxRetries: 1 });
  const model = options.model ?? "claude-opus-5";
  return {
    async interpret(utterances, signal) {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 4096,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: utterances.join("\n") }],
        },
        { signal },
      );
      if (response.stop_reason !== "end_turn") {
        throw new Error(`Interpreter stopped with reason ${response.stop_reason}`);
      }
      const text = response.content.find((block) => block.type === "text");
      if (!text || text.type !== "text") {
        throw new Error("Interpreter returned no text");
      }
      return parseInterpretation(text.text);
    },
  };
}

export function parseInterpretation(json: string): CallInterpretation {
  const value: unknown = JSON.parse(json);
  if (typeof value === "object" && value !== null && "summary" in value && typeof value.summary === "string") {
    return { summary: value.summary.trim() };
  }
  throw new Error("Interpreter output did not match the expected shape");
}
