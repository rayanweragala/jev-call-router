import { describe, expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevDecider, InvalidDecisionError, type DecisionContext } from "../src/index.ts";

const context: DecisionContext = {
  utterances: ["I was charged twice this month"],
  facts: { businessHours: true },
  routes: { sales: "Buying something.", billing: "Invoices and payments." },
};

function fakeJev(responseBody: unknown) {
  const requests: { url: string; body: any; headers: Headers }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json(responseBody);
  };
  const client = new TypeSafeClient({ apiKey: "test-key", fetch, retry: { maxRetries: 0 } });
  return { client, requests };
}

const billingAnswer = {
  model: "jev-1",
  usage: { input_tokens: 90, output_tokens: 1 },
  answers: {
    route: {
      type: "choice",
      choice: "billing",
      confidence: 0.93,
      probabilities: { sales: 0.02, billing: 0.95, "need-more-information": 0.02, "no-matching-route": 0.01 },
    },
  },
};

describe("Jev decision provider", () => {
  test("asks one choice question over the offered routes plus the reserved outcomes", async () => {
    const { client, requests } = fakeJev(billingAnswer);

    await createJevDecider({ client, model: "jev-latest" }).decide(context, new AbortController().signal);

    const request = requests[0]!;
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request.body.model).toBe("jev-latest");
    expect(request.body.state).toEqual({
      caller: { utterances: ["I was charged twice this month"] },
      call: { businessHours: true },
    });
    expect(request.body.questions.route.type).toBe("choice");
    expect(Object.keys(request.body.questions.route.criteria)).toEqual([
      "sales",
      "billing",
      "need-more-information",
      "no-matching-route",
    ]);
  });

  test("parses the typed answer into a decision", async () => {
    const { client } = fakeJev(billingAnswer);

    const decision = await createJevDecider({ client }).decide(context, new AbortController().signal);

    expect(decision).toEqual({
      outcome: "billing",
      confidence: 0.93,
      probabilities: billingAnswer.answers.route.probabilities,
      model: "jev-1",
    });
  });

  test("rejects a response without a route answer", async () => {
    const { client } = fakeJev({ model: "jev-1", answers: {}, usage: {} });

    const decide = createJevDecider({ client }).decide(context, new AbortController().signal);

    await expect(decide).rejects.toBeInstanceOf(InvalidDecisionError);
  });
});
