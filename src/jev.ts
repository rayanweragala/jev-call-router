import { choice, TypeSafeClient, type EntryType } from "@typesafe-ai/sdk";
import { NEED_MORE_INFORMATION, NO_MATCHING_ROUTE } from "./config.ts";
import {
  InvalidDecisionError,
  type Decision,
  type DecisionContext,
  type DecisionProvider,
  type JsonValue,
} from "./types.ts";

export interface JevOptions {
  apiKey?: string;
  client?: TypeSafeClient;
  model?: string;
}

const INSTRUCTIONS =
  "Choose where this phone call should be routed, based on what the caller wants. " +
  "Use only the caller's words and the call facts in the state.";

const RESERVED_CRITERIA: Record<string, string> = {
  [NEED_MORE_INFORMATION]:
    "The caller has not said enough yet to tell which destination they need, for example only a greeting, silence, or an unclear fragment.",
  [NO_MATCHING_ROUTE]:
    "The caller's request is clear, but none of the other destinations handle it.",
};

export function createJevDecider(options: JevOptions = {}): DecisionProvider {
  const client = options.client ?? new TypeSafeClient({ apiKey: options.apiKey, retry: { maxRetries: 1 } });
  return {
    async decide(context, signal) {
      const response = await client.systemOne(
        {
          model: options.model,
          state: buildJevState(context),
          questions: { route: choice(buildInstructions(context), buildCriteria(context)) },
        },
        { signal },
      );
      return toDecision(response.model, response.answers?.route);
    },
  };
}

export function buildJevState(context: DecisionContext): EntryType {
  const caller: Record<string, JsonValue> = context.summary !== undefined
    ? { summary: context.summary }
    : { utterances: context.utterances ?? [] };
  return { caller, call: context.facts };
}

export function buildCriteria(context: DecisionContext): Record<string, string> {
  return { ...context.routes, ...RESERVED_CRITERIA };
}

function buildInstructions(context: DecisionContext): string {
  const source = context.summary !== undefined
    ? "`caller.summary` is a short description of what the caller said."
    : "`caller.utterances` are speech-to-text transcripts of the caller and may contain recognition errors.";
  return `${INSTRUCTIONS} ${source} \`call\` holds facts from the phone system.`;
}

interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

function toDecision(model: string, answer: ChoiceAnswer | undefined): Decision {
  if (typeof answer?.choice !== "string" || typeof answer.confidence !== "number") {
    throw new InvalidDecisionError("Jev response did not contain a route choice");
  }
  return {
    outcome: answer.choice,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
    model,
  };
}
