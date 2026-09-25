import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  connectAsterisk,
  createCallRouter,
  parseDialplanTarget,
  textSpeech,
  validateAsteriskRoutes,
  ConfigError,
  type AsteriskConnection,
  type DecisionContext,
  type RoutingResult,
} from "../src/index.ts";

interface MockAri {
  port: number;
  requests: string[];
  authorization: string[];
  connected: Promise<ServerWebSocket<unknown>>;
  stop(): void;
}

function startMockAri(options: { callerSays: string; hangUpWhileRecording?: boolean }): MockAri {
  const requests: string[] = [];
  const authorization: string[] = [];
  let socket: ServerWebSocket<unknown> | undefined;
  let onConnected: (ws: ServerWebSocket<unknown>) => void = () => {};
  const connected = new Promise<ServerWebSocket<unknown>>((resolve) => (onConnected = resolve));
  const send = (event: object) => setTimeout(() => socket?.send(JSON.stringify(event)), 5);

  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      authorization.push(request.headers.get("Authorization") ?? "");
      if (url.pathname === "/ari/events") {
        return server.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      return handleRest(request.method, url);
    },
    websocket: {
      open(ws) {
        socket = ws;
        onConnected(ws);
      },
      message() {},
    },
  });

  function handleRest(method: string, url: URL): Response {
    const parts = url.pathname.split("/").filter(Boolean);
    const channelId = parts[2];
    const target_uri = `channel:${channelId}`;
    if (parts[3] === "play") {
      send({ type: "PlaybackFinished", playback: { id: parts[4], target_uri, state: "done" } });
      return Response.json({ id: parts[4] }, { status: 201 });
    }
    if (parts[3] === "record") {
      const name = url.searchParams.get("name");
      if (options.hangUpWhileRecording) {
        send({ type: "StasisEnd", channel: { id: channelId } });
      } else {
        send({ type: "RecordingFinished", recording: { name, target_uri, state: "done", duration: 3, talking_duration: 2 } });
      }
      return Response.json({ name }, { status: 201 });
    }
    if (parts[1] === "recordings" && parts[4] === "file") {
      return new Response(options.callerSays, { headers: { "Content-Type": "audio/wav" } });
    }
    if (parts[3] === "continue" || (method === "DELETE" && parts[1] === "channels")) {
      send({ type: "StasisEnd", channel: { id: channelId } });
    }
    return new Response(null, { status: 204 });
  }

  return {
    port: server.port!,
    requests,
    authorization,
    connected,
    stop: () => server.stop(true),
  };
}

const stasisStart = {
  type: "StasisStart",
  application: "jev-router",
  args: ["line=support", "jev=on"],
  channel: {
    id: "1700000000.42",
    state: "Ring",
    caller: { number: "+15551234567" },
    dialplan: { context: "from-pstn", exten: "8000", priority: 2 },
  },
};

let mock: MockAri | undefined;
let connection: AsteriskConnection | undefined;

afterEach(() => {
  connection?.close();
  mock?.stop();
});

function routeThroughMockAri(callerSays: string, hangUpWhileRecording = false) {
  mock = startMockAri({ callerSays, hangUpWhileRecording });
  const contexts: DecisionContext[] = [];
  let finish: (result: RoutingResult) => void = () => {};
  const finished = new Promise<RoutingResult>((resolve) => (finish = resolve));
  const router = createCallRouter({
    decider: {
      async decide(context) {
        contexts.push(context);
        return { outcome: "billing", confidence: 0.92, probabilities: {}, model: "jev-test" };
      },
    },
    speech: textSpeech,
    routes: {
      billing: { description: "Invoices and payments.", action: { type: "transfer", destination: "ext-queues,402,1" } },
      operator: { action: { type: "transfer", destination: "from-did-direct,100" } },
    },
    fallbackRoute: "operator",
    prompts: { greeting: "sound:custom/jev-greeting" },
    facts: (call) => ({ line: call.variables.line ?? "main" }),
    onResult: finish,
  });
  connection = connectAsterisk({
    url: `http://127.0.0.1:${mock.port}`,
    username: "jev",
    password: "ari-secret",
    app: "jev-router",
    router,
  });
  return { mock, contexts, finished };
}

describe("Asterisk ARI adapter against a mock ARI server", () => {
  test("answers, prompts, records, routes and continues in the dialplan", async () => {
    const { mock, contexts, finished } = routeThroughMockAri("I was charged twice");
    (await mock.connected).send(JSON.stringify(stasisStart));

    const result = await finished;

    expect(result.route).toBe("billing");
    expect(contexts[0]!.utterances).toEqual(["I was charged twice"]);
    expect(contexts[0]!.facts).toEqual({ line: "support" });
    const channel = "/ari/channels/1700000000.42";
    const recording = "jev-1700000000.42-1";
    expect(mock.requests[0]).toBe(`POST ${channel}/answer`);
    expect(mock.requests[1]).toStartWith(`POST ${channel}/play/`);
    expect(mock.requests[1]).toContain("media=sound%3Acustom%2Fjev-greeting");
    expect(mock.requests[2]).toStartWith(`POST ${channel}/record?name=${recording}&format=wav`);
    expect(mock.requests.slice(3)).toEqual([
      `GET /ari/recordings/stored/${recording}/file`,
      `DELETE /ari/recordings/stored/${recording}`,
      `POST ${channel}/continue?context=ext-queues&extension=402&priority=1`,
    ]);
    expect(new Set(mock.authorization)).toEqual(new Set([`Basic ${btoa("jev:ari-secret")}`]));
  });

  test("stops cleanly when the caller hangs up while being recorded", async () => {
    const { mock, contexts, finished } = routeThroughMockAri("", true);
    (await mock.connected).send(JSON.stringify(stasisStart));

    const result = await finished;

    expect(result.outcome).toBe("caller-hung-up");
    expect(contexts).toHaveLength(0);
    expect(mock.requests.some((request) => request.includes("/continue"))).toBe(false);
  });
});

describe("Asterisk dialplan destinations", () => {
  test("parses context, extension and priority or label", () => {
    expect(parseDialplanTarget("ext-queues,400,1")).toEqual({ context: "ext-queues", extension: "400", priority: 1 });
    expect(parseDialplanTarget("from-did-direct, 100")).toEqual({ context: "from-did-direct", extension: "100", priority: 1 });
    expect(parseDialplanTarget("support,s,start")).toEqual({ context: "support", extension: "s", label: "start" });
  });

  test("rejects malformed destinations at startup", () => {
    const routes = { bad: { action: { type: "transfer" as const, destination: "just-a-context" } } };
    expect(() => validateAsteriskRoutes(routes)).toThrow(ConfigError);
  });
});
