import { describe, expect, test } from "bun:test";
import {
  CallEndedError,
  createCallRouter,
  createScriptedSession,
  textSpeech,
  type CallRouterConfig,
  type Decision,
  type DecisionContext,
  type DecisionProvider,
} from "../src/index.ts";

const call = { id: "call-1", caller: "+15551234567", dialed: "8000", variables: {} };

function decision(outcome: string, confidence = 0.9): Decision {
  return { outcome, confidence, probabilities: { [outcome]: confidence }, model: "jev-test" };
}

function scriptedDecider(...decisions: Decision[]): DecisionProvider & { contexts: DecisionContext[] } {
  const contexts: DecisionContext[] = [];
  return {
    contexts,
    async decide(context) {
      contexts.push(context);
      const next = decisions.shift();
      if (!next) {
        throw new Error("No scripted decision left");
      }
      return next;
    },
  };
}

function config(overrides: Partial<CallRouterConfig> = {}): CallRouterConfig {
  return {
    decider: scriptedDecider(decision("billing")),
    speech: textSpeech,
    routes: {
      sales: { description: "Buying something.", action: { type: "transfer", destination: "sales,100,1" } },
      billing: { description: "Invoices and payments.", action: { type: "transfer", destination: "billing,200,1" } },
      reception: {
        action: { type: "transfer", destination: "reception,300,1" },
        announcement: "sound:connecting",
      },
      "normal-ivr": { action: { type: "continue" } },
    },
    fallbackRoute: "reception",
    prompts: { greeting: "sound:greeting", retry: "sound:retry" },
    ...overrides,
  };
}

describe("routing a call with Jev", () => {
  test("transfers to the route Jev chose", async () => {
    const router = createCallRouter(config());
    const session = createScriptedSession(call, ["I was charged twice"]);

    const result = await router.handleCall(session);

    expect(result.outcome).toBe("jev");
    expect(result.route).toBe("billing");
    expect(result.decision?.confidence).toBe(0.9);
    expect(session.played).toEqual(["sound:greeting"]);
    expect(session.executed).toEqual([{ type: "transfer", destination: "billing,200,1" }]);
  });

  test("offers Jev only described routes and never the caller number", async () => {
    const decider = scriptedDecider(decision("billing"));
    const router = createCallRouter(config({ decider, facts: () => ({ businessHours: true }) }));

    await router.handleCall(createScriptedSession(call, ["I was charged twice"]));

    const context = decider.contexts[0]!;
    expect(Object.keys(context.routes)).toEqual(["sales", "billing"]);
    expect(context.utterances).toEqual(["I was charged twice"]);
    expect(context.facts).toEqual({ businessHours: true });
    expect(JSON.stringify(context)).not.toContain(call.caller);
  });

  test("asks again when Jev needs more information, then routes", async () => {
    const decider = scriptedDecider(decision("need-more-information"), decision("sales"));
    const router = createCallRouter(config({ decider }));
    const session = createScriptedSession(call, ["hello?", "I want to buy a phone system"]);

    const result = await router.handleCall(session);

    expect(result.route).toBe("sales");
    expect(result.attempts).toBe(2);
    expect(session.played).toEqual(["sound:greeting", "sound:retry"]);
    expect(decider.contexts[1]!.utterances).toEqual(["hello?", "I want to buy a phone system"]);
  });

  test("sends only the interpreter summary to Jev when an interpreter is configured", async () => {
    const decider = scriptedDecider(decision("billing"));
    const interpreter = { interpret: async () => ({ summary: "Caller was charged twice." }) };
    const router = createCallRouter(config({ decider, interpreter }));

    await router.handleCall(createScriptedSession(call, ["My card 4111 1111 was charged twice"]));

    expect(decider.contexts[0]!.summary).toBe("Caller was charged twice.");
    expect(decider.contexts[0]!.utterances).toBeUndefined();
  });

  test("routes deterministically without calling Jev", async () => {
    const decider = scriptedDecider();
    const router = createCallRouter(config({ decider, routeDirectly: () => "normal-ivr" }));
    const session = createScriptedSession({ ...call, variables: { jev: "off" } }, []);

    const result = await router.handleCall(session);

    expect(result.outcome).toBe("direct");
    expect(session.executed).toEqual([{ type: "continue" }]);
    expect(decider.contexts).toHaveLength(0);
    expect(session.played).toEqual([]);
  });

  test("routes a transcript without a phone session", async () => {
    const router = createCallRouter(config());

    const result = await router.routeTranscript(call, ["I was charged twice"]);

    expect(result.route).toBe("billing");
    expect(result.action).toEqual({ type: "transfer", destination: "billing,200,1" });
  });
});

describe("fallback behavior", () => {
  async function fallbackFor(overrides: Partial<CallRouterConfig>, utterances: (string | undefined)[] = ["help"]) {
    const router = createCallRouter(config(overrides));
    const session = createScriptedSession(call, utterances);
    const result = await router.handleCall(session);
    return { result, session };
  }

  test("an outcome that is not an offered route is rejected", async () => {
    const { result, session } = await fallbackFor({ decider: scriptedDecider(decision("reception")) });

    expect(result.outcome).toBe("fallback");
    expect(result.fallbackReason).toBe("invalid-decision");
    expect(session.executed).toEqual([{ type: "transfer", destination: "reception,300,1" }]);
    expect(session.played).toContain("sound:connecting");
  });

  test("a decision without a usable confidence is rejected", async () => {
    const { result } = await fallbackFor({ decider: scriptedDecider(decision("billing", Number.NaN)) });
    expect(result.fallbackReason).toBe("invalid-decision");
  });

  test("low confidence on every attempt falls back", async () => {
    const decider = scriptedDecider(decision("billing", 0.4), decision("sales", 0.5));
    const { result } = await fallbackFor({ decider }, ["uh", "hmm"]);
    expect(result.fallbackReason).toBe("low-confidence");
    expect(result.attempts).toBe(2);
  });

  test("a clear request with no matching route falls back immediately", async () => {
    const { result } = await fallbackFor({ decider: scriptedDecider(decision("no-matching-route")) });
    expect(result.fallbackReason).toBe("no-matching-route");
    expect(result.attempts).toBe(1);
  });

  test("silence on every attempt falls back without calling Jev", async () => {
    const decider = scriptedDecider();
    const { result } = await fallbackFor({ decider }, [undefined, undefined]);
    expect(result.fallbackReason).toBe("no-speech");
    expect(decider.contexts).toHaveLength(0);
  });

  test("a Jev failure falls back", async () => {
    const decider = { decide: async () => Promise.reject(new Error("503 from Jev")) };
    const { result } = await fallbackFor({ decider });
    expect(result.fallbackReason).toBe("decision-failed");
    expect(result.error).toContain("503 from Jev");
  });

  test("a slow Jev call times out and falls back", async () => {
    const decider = { decide: () => new Promise<Decision>(() => {}) };
    const { result } = await fallbackFor({ decider, timeouts: { decisionMs: 20 } });
    expect(result.fallbackReason).toBe("timeout");
  });

  test("a transcription failure falls back", async () => {
    const speech = { transcribe: async () => Promise.reject(new Error("STT down")) };
    const { result } = await fallbackFor({ speech });
    expect(result.fallbackReason).toBe("speech-failed");
  });

  test("an interpreter failure falls back instead of sending the raw transcript", async () => {
    const decider = scriptedDecider(decision("billing"));
    const interpreter = { interpret: async () => Promise.reject(new Error("LLM down")) };
    const { result } = await fallbackFor({ decider, interpreter });
    expect(result.fallbackReason).toBe("interpreter-failed");
    expect(decider.contexts).toHaveLength(0);
  });

  test("a direct route that does not exist falls back", async () => {
    const { result } = await fallbackFor({ routeDirectly: () => "missing" });
    expect(result.fallbackReason).toBe("unknown-route");
  });

  test("a failed transfer is retried on the fallback route", async () => {
    const router = createCallRouter(config());
    const session = createScriptedSession(call, ["I was charged twice"]);
    session.execute = async (action) => {
      if (action.type === "transfer" && action.destination.startsWith("billing")) {
        throw new Error("no such extension");
      }
      session.executed.push(action);
    };

    const result = await router.handleCall(session);

    expect(result.fallbackReason).toBe("action-failed");
    expect(result.decision?.outcome).toBe("billing");
    expect(session.executed).toEqual([{ type: "transfer", destination: "reception,300,1" }]);
  });

  test("when every transfer fails the call is returned to the PBX", async () => {
    const router = createCallRouter(config());
    const session = createScriptedSession(call, ["I was charged twice"]);
    session.execute = async (action) => {
      if (action.type === "transfer") {
        throw new Error("PBX rejected transfer");
      }
      session.executed.push(action);
    };

    const result = await router.handleCall(session);

    expect(result.outcome).toBe("fallback");
    expect(session.executed).toEqual([{ type: "continue" }]);
  });

  test("a caller hang-up stops routing without executing anything", async () => {
    const router = createCallRouter(config());
    const session = createScriptedSession(call, []);
    session.recordUtterance = async () => {
      throw new CallEndedError(call.id);
    };

    const result = await router.handleCall(session);

    expect(result.outcome).toBe("caller-hung-up");
    expect(session.executed).toEqual([]);
  });

  test("results are reported with timings", async () => {
    const reported: string[] = [];
    const router = createCallRouter(config({ onResult: (result) => void reported.push(result.route!) }));

    const result = await router.handleCall(createScriptedSession(call, ["I was charged twice"]));

    expect(reported).toEqual(["billing"]);
    expect(result.timings.decisionMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });
});
