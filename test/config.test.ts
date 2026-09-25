import { describe, expect, test } from "bun:test";
import { ConfigError, createCallRouter, textSpeech, type CallRouterConfig } from "../src/index.ts";

const valid: CallRouterConfig = {
  decider: { decide: async () => ({ outcome: "sales", confidence: 1, probabilities: {}, model: "m" }) },
  speech: textSpeech,
  routes: {
    sales: { description: "Buying.", action: { type: "transfer", destination: "sales,100" } },
    operator: { action: { type: "transfer", destination: "operator,0" } },
  },
  fallbackRoute: "operator",
  prompts: { greeting: "sound:hello" },
};

describe("configuration validation", () => {
  test("accepts a valid configuration", () => {
    expect(() => createCallRouter(valid)).not.toThrow();
  });

  test.each([
    ["an undefined fallback route", { fallbackRoute: "nobody" }],
    ["no routes", { routes: {} }],
    ["no route Jev can choose", { routes: { operator: valid.routes.operator! } }],
    ["a reserved route name", { routes: { ...valid.routes, "need-more-information": valid.routes.operator! } }],
    ["an invalid route name", { routes: { ...valid.routes, "Sales Team": valid.routes.operator! } }],
    ["an empty transfer destination", { routes: { ...valid.routes, empty: { action: { type: "transfer", destination: " " } } } }],
    ["an out-of-range confidence", { minConfidence: 1.5 }],
    ["zero attempts", { maxAttempts: 0 }],
    ["a negative timeout", { timeouts: { decisionMs: -1 } }],
  ] as const)("rejects %s", (_, overrides) => {
    expect(() => createCallRouter({ ...valid, ...overrides } as CallRouterConfig)).toThrow(ConfigError);
  });
});
