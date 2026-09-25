import type { JsonValue } from "@typesafe-ai/sdk";

export type { JsonValue };

export interface CallInfo {
  id: string;
  caller?: string;
  dialed?: string;
  variables: Record<string, string>;
}

export type CallAction =
  | { type: "transfer"; destination: string }
  | { type: "continue" }
  | { type: "hangup" };

export interface Route {
  description?: string;
  action: CallAction;
  announcement?: string;
}

export interface CallerAudio {
  data: Uint8Array;
  mimeType: string;
}

export interface CallSession {
  readonly call: CallInfo;
  play(media: string): Promise<void>;
  recordUtterance(): Promise<CallerAudio | undefined>;
  execute(action: CallAction): Promise<void>;
}

export class CallEndedError extends Error {
  constructor(callId: string) {
    super(`Call ${callId} ended`);
    this.name = "CallEndedError";
  }
}

export class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecisionError";
  }
}

export interface SpeechToText {
  transcribe(audio: CallerAudio, signal: AbortSignal): Promise<string>;
}

export interface CallInterpretation {
  summary: string;
}

export interface CallInterpreter {
  interpret(utterances: string[], signal: AbortSignal): Promise<CallInterpretation>;
}

export interface DecisionContext {
  utterances?: string[];
  summary?: string;
  facts: Record<string, JsonValue>;
  routes: Record<string, string>;
}

export interface Decision {
  outcome: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
}

export interface DecisionProvider {
  decide(context: DecisionContext, signal: AbortSignal): Promise<Decision>;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface Timeouts {
  speechMs: number;
  interpreterMs: number;
  decisionMs: number;
}

export interface CallRouterConfig {
  decider: DecisionProvider;
  speech: SpeechToText;
  interpreter?: CallInterpreter;
  routes: Record<string, Route>;
  fallbackRoute: string;
  prompts: { greeting: string; retry?: string };
  maxAttempts?: number;
  minConfidence?: number;
  timeouts?: Partial<Timeouts>;
  routeDirectly?: (call: CallInfo) => string | undefined;
  facts?: (call: CallInfo) => Record<string, JsonValue>;
  logger?: Logger;
  onResult?: (result: RoutingResult) => void | Promise<void>;
}

export type FallbackReason =
  | "no-speech"
  | "speech-failed"
  | "interpreter-failed"
  | "decision-failed"
  | "timeout"
  | "invalid-decision"
  | "low-confidence"
  | "need-more-information"
  | "no-matching-route"
  | "unknown-route"
  | "action-failed"
  | "pbx-error";

export interface Timings {
  speechMs?: number;
  interpreterMs?: number;
  decisionMs?: number;
  totalMs: number;
}

export interface RoutingResult {
  callId: string;
  outcome: "jev" | "direct" | "fallback" | "caller-hung-up";
  route?: string;
  action?: CallAction;
  fallbackReason?: FallbackReason;
  error?: string;
  decision?: Decision;
  offeredRoutes: string[];
  attempts: number;
  timings: Timings;
}
