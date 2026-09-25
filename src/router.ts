import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_TIMEOUTS,
  NEED_MORE_INFORMATION,
  NO_MATCHING_ROUTE,
  jevRouteNames,
  validateConfig,
} from "./config.ts";
import { describeError, silentLogger } from "./logger.ts";
import {
  CallEndedError,
  InvalidDecisionError,
  type CallInfo,
  type CallRouterConfig,
  type CallSession,
  type Decision,
  type DecisionContext,
  type FallbackReason,
  type RoutingResult,
  type Timings,
} from "./types.ts";

export interface CallRouter {
  handleCall(session: CallSession): Promise<RoutingResult>;
  routeTranscript(call: CallInfo, utterances: string[]): Promise<RoutingResult>;
}

export type Step =
  | { kind: "route"; route: string; source: "jev" | "direct"; decision?: Decision }
  | { kind: "retry"; reason: FallbackReason; decision?: Decision }
  | { kind: "fallback"; reason: FallbackReason; decision?: Decision; error?: string };

type FinalStep = Exclude<Step, { kind: "retry" }>;

type StageResult<T> = { ok: true; value: T } | { ok: false; step: FinalStep };

type TimingKey = "speechMs" | "interpreterMs" | "decisionMs";

interface Trace {
  call: CallInfo;
  startedAt: number;
  attempts: number;
  timings: Omit<Timings, "totalMs">;
}

class StageTimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = "StageTimeoutError";
  }
}

export function evaluateDecision(
  decision: Decision,
  offeredRoutes: string[],
  minConfidence: number,
): Step {
  if (!Number.isFinite(decision.confidence)) {
    return { kind: "fallback", reason: "invalid-decision", decision };
  }
  if (decision.outcome === NEED_MORE_INFORMATION) {
    return { kind: "retry", reason: "need-more-information", decision };
  }
  if (decision.outcome === NO_MATCHING_ROUTE) {
    return { kind: "fallback", reason: "no-matching-route", decision };
  }
  if (!offeredRoutes.includes(decision.outcome)) {
    return { kind: "fallback", reason: "invalid-decision", decision };
  }
  if (decision.confidence < minConfidence) {
    return { kind: "retry", reason: "low-confidence", decision };
  }
  return { kind: "route", route: decision.outcome, source: "jev", decision };
}

export function createCallRouter(config: CallRouterConfig): CallRouter {
  validateConfig(config);
  const logger = config.logger ?? silentLogger;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const offeredRoutes = jevRouteNames(config.routes);

  async function handleCall(session: CallSession): Promise<RoutingResult> {
    const trace = startTrace(session.call);
    logger.info("call.started", { callId: trace.call.id });
    let result: RoutingResult;
    try {
      const step = await chooseRoute(session, trace);
      result = await executeStep(session, step, trace);
    } catch (error) {
      result = await recoverFromPbxError(session, error, trace);
    }
    await report(result);
    return result;
  }

  async function routeTranscript(call: CallInfo, utterances: string[]): Promise<RoutingResult> {
    const trace = startTrace(call);
    trace.attempts = 1;
    const direct = directStep(call);
    const step = direct ?? toFinal(await decide(call, utterances, trace));
    const result = buildResult(trace, step);
    await report(result);
    return result;
  }

  async function chooseRoute(session: CallSession, trace: Trace): Promise<FinalStep> {
    const direct = directStep(session.call);
    if (direct) {
      return direct;
    }
    const utterances: string[] = [];
    let last: Step = { kind: "retry", reason: "no-speech" };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      trace.attempts = attempt;
      await session.play(promptFor(attempt));
      const heard = await listen(session, trace);
      if (!heard.ok) {
        return heard.step;
      }
      if (!heard.value) {
        last = { kind: "retry", reason: "no-speech" };
        continue;
      }
      utterances.push(heard.value);
      last = await decide(session.call, utterances, trace);
      if (last.kind !== "retry") {
        return last;
      }
      logger.info("call.retry", { callId: trace.call.id, attempt, reason: last.reason });
    }
    return toFinal(last);
  }

  function directStep(call: CallInfo): FinalStep | undefined {
    const route = config.routeDirectly?.(call);
    if (route === undefined) {
      return undefined;
    }
    if (!config.routes[route]) {
      logger.warn("route.unknown", { callId: call.id, route });
      return { kind: "fallback", reason: "unknown-route" };
    }
    return { kind: "route", route, source: "direct" };
  }

  function promptFor(attempt: number): string {
    if (attempt === 1) {
      return config.prompts.greeting;
    }
    return config.prompts.retry ?? config.prompts.greeting;
  }

  async function listen(session: CallSession, trace: Trace): Promise<StageResult<string>> {
    const audio = await session.recordUtterance();
    if (!audio) {
      return { ok: true, value: "" };
    }
    const heard = await runStage(trace, "speechMs", "speech-failed", (signal) =>
      config.speech.transcribe(audio, signal),
    );
    if (!heard.ok) {
      return heard;
    }
    return { ok: true, value: heard.value.trim() };
  }

  async function decide(call: CallInfo, utterances: string[], trace: Trace): Promise<Step> {
    const context = await buildContext(call, utterances, trace);
    if (!context.ok) {
      return context.step;
    }
    logger.info("decision.requested", {
      callId: call.id,
      routes: offeredRoutes,
      utterances: utterances.length,
    });
    const decision = await runStage(trace, "decisionMs", "decision-failed", (signal) =>
      config.decider.decide(context.value, signal),
    );
    if (!decision.ok) {
      return decision.step;
    }
    logger.info("decision.received", {
      callId: call.id,
      outcome: decision.value.outcome,
      confidence: decision.value.confidence,
      model: decision.value.model,
    });
    return evaluateDecision(decision.value, offeredRoutes, minConfidence);
  }

  async function buildContext(
    call: CallInfo,
    utterances: string[],
    trace: Trace,
  ): Promise<StageResult<DecisionContext>> {
    const facts = config.facts?.(call) ?? {};
    const routes = Object.fromEntries(
      offeredRoutes.map((name) => [name, config.routes[name]!.description!]),
    );
    const interpreter = config.interpreter;
    if (!interpreter) {
      return { ok: true, value: { utterances, facts, routes } };
    }
    const interpretation = await runStage(trace, "interpreterMs", "interpreter-failed", (signal) =>
      interpreter.interpret(utterances, signal),
    );
    if (!interpretation.ok) {
      return interpretation;
    }
    return { ok: true, value: { summary: interpretation.value.summary, facts, routes } };
  }

  async function runStage<T>(
    trace: Trace,
    key: TimingKey,
    reason: FallbackReason,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<StageResult<T>> {
    const startedAt = performance.now();
    try {
      return { ok: true, value: await withTimeout(timeouts[key], run) };
    } catch (error) {
      const failure = classifyFailure(error, reason);
      logger.warn("provider.failed", {
        callId: trace.call.id,
        stage: key.replace("Ms", ""),
        reason: failure,
        error: describeError(error),
      });
      return { ok: false, step: { kind: "fallback", reason: failure, error: describeError(error) } };
    } finally {
      trace.timings[key] = (trace.timings[key] ?? 0) + elapsed(startedAt);
    }
  }

  async function executeStep(
    session: CallSession,
    step: FinalStep,
    trace: Trace,
  ): Promise<RoutingResult> {
    const route = step.kind === "route" ? step.route : config.fallbackRoute;
    try {
      await executeRoute(session, route);
      return buildResult(trace, step);
    } catch (error) {
      if (error instanceof CallEndedError) {
        return buildEndedResult(trace);
      }
      logger.error("action.failed", { callId: trace.call.id, route, error: describeError(error) });
      return executeFallbackAfterFailure(session, step, route, trace, error);
    }
  }

  async function executeFallbackAfterFailure(
    session: CallSession,
    original: FinalStep,
    failedRoute: string,
    trace: Trace,
    cause: unknown,
  ): Promise<RoutingResult> {
    const reason = original.kind === "fallback" ? original.reason : "action-failed";
    const step: FinalStep = {
      kind: "fallback",
      reason,
      decision: original.decision,
      error: describeError(cause),
    };
    if (failedRoute !== config.fallbackRoute) {
      try {
        await executeRoute(session, config.fallbackRoute);
        return buildResult(trace, step);
      } catch (error) {
        if (error instanceof CallEndedError) {
          return buildEndedResult(trace);
        }
        logger.error("action.failed", {
          callId: trace.call.id,
          route: config.fallbackRoute,
          error: describeError(error),
        });
      }
    }
    await returnCallToPbx(session, trace);
    return { ...buildResult(trace, step), route: undefined, action: { type: "continue" } };
  }

  async function executeRoute(session: CallSession, name: string): Promise<void> {
    const route = config.routes[name]!;
    if (route.announcement) {
      await playAnnouncement(session, route.announcement);
    }
    await session.execute(route.action);
  }

  async function playAnnouncement(session: CallSession, media: string): Promise<void> {
    try {
      await session.play(media);
    } catch (error) {
      if (error instanceof CallEndedError) {
        throw error;
      }
      logger.warn("announcement.failed", { callId: session.call.id, error: describeError(error) });
    }
  }

  async function returnCallToPbx(session: CallSession, trace: Trace): Promise<void> {
    try {
      await session.execute({ type: "continue" });
      logger.warn("call.returned_to_pbx", { callId: trace.call.id });
    } catch (error) {
      logger.error("call.unrecoverable", { callId: trace.call.id, error: describeError(error) });
    }
  }

  async function recoverFromPbxError(
    session: CallSession,
    error: unknown,
    trace: Trace,
  ): Promise<RoutingResult> {
    if (error instanceof CallEndedError) {
      return buildEndedResult(trace);
    }
    logger.error("pbx.error", { callId: trace.call.id, error: describeError(error) });
    const step: FinalStep = { kind: "fallback", reason: "pbx-error", error: describeError(error) };
    return executeStep(session, step, trace);
  }

  function buildResult(trace: Trace, step: FinalStep): RoutingResult {
    const route = step.kind === "route" ? step.route : config.fallbackRoute;
    return {
      callId: trace.call.id,
      outcome: step.kind === "route" ? step.source : "fallback",
      route,
      action: config.routes[route]!.action,
      fallbackReason: step.kind === "fallback" ? step.reason : undefined,
      error: step.kind === "fallback" ? step.error : undefined,
      decision: step.decision,
      offeredRoutes,
      attempts: trace.attempts,
      timings: { ...trace.timings, totalMs: elapsed(trace.startedAt) },
    };
  }

  function buildEndedResult(trace: Trace): RoutingResult {
    return {
      callId: trace.call.id,
      outcome: "caller-hung-up",
      offeredRoutes,
      attempts: trace.attempts,
      timings: { ...trace.timings, totalMs: elapsed(trace.startedAt) },
    };
  }

  async function report(result: RoutingResult): Promise<void> {
    const fields = {
      callId: result.callId,
      outcome: result.outcome,
      route: result.route,
      fallbackReason: result.fallbackReason,
      confidence: result.decision?.confidence,
      attempts: result.attempts,
      timings: result.timings,
    };
    if (result.outcome === "fallback") {
      logger.warn("fallback.triggered", fields);
    } else {
      logger.info("call.routed", fields);
    }
    try {
      await config.onResult?.(result);
    } catch (error) {
      logger.error("on_result.failed", { callId: result.callId, error: describeError(error) });
    }
  }

  return { handleCall, routeTranscript };
}

function classifyFailure(error: unknown, reason: FallbackReason): FallbackReason {
  if (error instanceof StageTimeoutError) {
    return "timeout";
  }
  if (error instanceof InvalidDecisionError) {
    return "invalid-decision";
  }
  return reason;
}

function toFinal(step: Step): FinalStep {
  if (step.kind === "retry") {
    return { kind: "fallback", reason: step.reason, decision: step.decision };
  }
  return step;
}

function startTrace(call: CallInfo): Trace {
  return { call, startedAt: performance.now(), attempts: 0, timings: {} };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StageTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
