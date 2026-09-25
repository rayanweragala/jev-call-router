# jev-call-router

A small TypeScript service and library that uses [Jev by TypeSafe AI](https://typesafe.ai) as the decision layer for phone calls. It sits between a PBX (such as Asterisk or FreePBX) and your call destinations, classifying caller intent to decide PBX actions.

Jev never controls the PBX directly. You define the allowed outcomes, this project maps each outcome to an explicit call action, and the PBX executes it.

## The problem it solves

Traditional IVRs require callers to navigate numeric keypads, while letting an LLM control PBX actions directly risks arbitrary commands. This project uses Jev to classify caller intent into predefined routes:

- Callers speak naturally.
- Jev selects from defined routes and returns a typed answer with a confidence score.
- Low confidence, outages, or unhandled requests route to a designated fallback.

## Call flow

```
Incoming call → Asterisk / FreePBX dialplan → Stasis(jev-router)
      ↓
  routeDirectly(call)?  ── yes ──→ your deterministic route (Jev is skipped)
      ↓ no
  play greeting → record caller → speech-to-text
      ↓
  (optional) interpreter → short summary without personal details
      ↓
  Jev: choose one of { your described routes, need-more-information, no-matching-route }
      ↓
  validate: known route? confidence ≥ minConfidence?
      ├─ need more info / low confidence → ask again (up to maxAttempts)
      ├─ invalid / failure / timeout     → fallbackRoute
      └─ ok                              → route.action
      ↓
  PBX executes: transfer to a dialplan destination, continue in the dialplan, or hang up
```

## Architecture

```
src/
  types.ts            Public types: routes, actions, providers, sessions, results
  config.ts           Validation, defaults, requireEnv
  router.ts           The call flow above (createCallRouter)
  jev.ts              Jev decision provider (official @typesafe-ai/sdk)
  logger.ts           Structured JSON logging
  providers/
    speech.ts         Speech-to-text over any OpenAI-style /audio/transcriptions API
    interpreter.ts    Optional Claude interpreter that summarizes and removes personal details
  pbx/asterisk/       Asterisk ARI adapter (no dependency: fetch + WebSocket)
  testing.ts          Scripted call session for tests and simulations
  server.ts           Service entry point (bun start)
router.config.ts      Your routes and providers
```

The core (`router.ts`, `jev.ts`, `types.ts`) knows nothing about Asterisk. A PBX adapter only has to implement `CallSession`:

```ts
interface CallSession {
  call: CallInfo;
  play(media: string): Promise<void>;
  recordUtterance(): Promise<CallerAudio | undefined>;
  execute(action: CallAction): Promise<void>;
}
```

## Requirements

- [Bun](https://bun.sh) 1.3+
- A TypeSafe API key for Jev
- A speech-to-text service with an OpenAI-style `/audio/transcriptions` endpoint (OpenAI, Groq, a self-hosted Whisper server, and others)
- Asterisk 16+ with ARI enabled, or FreePBX 16/17 (which runs Asterisk underneath)

## Install and configure

```bash
git clone <this repo> && cd jev-call-router
bun install
cp .env.example .env    # then fill in values; .env is gitignored
```

| Variable | Required | Purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | yes | Jev API key |
| `TYPESAFE_DEFAULT_MODEL` | no | Pin a Jev model (SDK default: `jev-latest`) |
| `STT_API_KEY`, `STT_BASE_URL`, `STT_MODEL` | yes | Speech-to-text service |
| `STT_LANGUAGE` | no | Language hint such as `en` |
| `ARI_URL`, `ARI_USERNAME`, `ARI_PASSWORD` | yes for `bun start` | Asterisk REST Interface |
| `ARI_APP` | no | Stasis app name (default `jev-router`) |
| `ANTHROPIC_API_KEY` | only with the interpreter | Claude interpreter |

### Jev configuration

Create an API key in your TypeSafe account (see [docs.typesafe.ai](https://docs.typesafe.ai)) and put it in `.env` as `TYPESAFE_API_KEY`. Never commit it. The router uses the official `@typesafe-ai/sdk` `systemOne` API. Each decision is one `choice` question whose options are your described routes plus two reserved outcomes: `need-more-information` and `no-matching-route`.

## Minimal example

```ts
import { createCallRouter, createJevDecider, createTranscriptionSpeech, requireEnv } from "jev-call-router";

const router = createCallRouter({
  decider: createJevDecider({ apiKey: requireEnv("TYPESAFE_API_KEY") }),
  speech: createTranscriptionSpeech({
    apiKey: requireEnv("STT_API_KEY"),
    baseUrl: requireEnv("STT_BASE_URL"),
    model: requireEnv("STT_MODEL"),
  }),
  routes: {
    sales:   { description: "Buying, pricing, quotes.",      action: { type: "transfer", destination: "ext-queues,400,1" } },
    support: { description: "Something is broken.",          action: { type: "transfer", destination: "ext-queues,401,1" } },
    billing: { description: "Invoices, charges, refunds.",   action: { type: "transfer", destination: "ext-queues,402,1" } },
    "human-agent": { action: { type: "transfer", destination: "from-did-direct,100,1" } },
  },
  fallbackRoute: "human-agent",
  prompts: { greeting: "sound:custom/jev-greeting" },
});

await router.handleCall(session);                               // a CallSession from a PBX adapter
await router.routeTranscript(call, ["I was charged twice"]);    // decide only, no audio or PBX
```

## How routing decisions work

1. Deterministic rules run first via `routeDirectly(call)` for VIP lists, business hours, per-number opt-in, or dialplan flags. Jev is not called when a route is returned.
2. Only routes with a `description` are offered to Jev. Routes without descriptions are reached only via `routeDirectly` or as the fallback.
3. Jev receives minimal context: the caller's speech (or interpreter summary), the route descriptions, and facts returned by `facts(call)`. Caller ID and internal channel data are omitted unless explicitly included.
4. Decisions require a known route with confidence at or above `minConfidence` (default `0.7`). Low confidence or `need-more-information` triggers a retry prompt, up to `maxAttempts` (default `2`).
5. Actions map explicitly to `transfer` (a PBX destination), `continue` (return to the dialplan), or `hangup`, with an optional `announcement` played first.

## Custom routing outcomes

Routes are plain data. Add, rename, or remove them in `router.config.ts`. Names use lowercase letters, digits, `-` and `_`. The two reserved names above are rejected. See [`examples/routing-scenarios.ts`](examples/routing-scenarios.ts) for several complete setups.

## Fallback behavior

`fallbackRoute` is required and must name one of your routes. The router falls back on: no speech, speech-to-text failure, interpreter failure, Jev failure, timeout, invalid decision, `no-matching-route`, repeated low confidence or `need-more-information`, an unknown direct route, or a PBX error. If the chosen route's action fails, the router tries the fallback. If that also fails, it returns the call to the dialplan (`continue`), where your PBX-side fallback line runs. If the caller hangs up, nothing is executed.

Every call produces a `RoutingResult` (passed to `onResult` and logged) with the outcome, route, fallback reason, Jev's choice, confidence and probabilities, offered routes, attempts, and per-stage timings.

## Asterisk and FreePBX

The Asterisk adapter uses ARI: the dialplan hands the call to `Stasis(jev-router)`, and the router answers, plays prompts, records the caller, and then continues the channel in the dialplan at the chosen destination. Transfer destinations are dialplan targets written as `context,extension[,priority]`.

FreePBX is Asterisk with a management layer, so it uses the same adapter. There is no FreePBX-specific code. You add one custom dialplan context and a Custom Destination, and route destinations point at FreePBX contexts such as `ext-queues,400,1`, `ext-group,600,1`, `from-did-direct,100,1`, or `ext-local,vmu100,1`.

Step-by-step setup: [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Run

```bash
bun start                                              # connect to Asterisk and route calls
bun run simulate "I think I was charged twice"         # full call flow with text instead of audio, real Jev
bun run simulate "hello?" "I need to pay my invoice"   # second utterance answers the retry prompt
```

## Tests and development

```bash
bun test            # router scenarios, fallbacks, Jev request/response contract, ARI adapter against a mock ARI server
bun run typecheck   # tsc --noEmit (strict)
```

The tests focus on behavior that matters on a live call: decision validation, every fallback path, context minimization, action-failure recovery, caller hang-up, and the exact ARI requests the adapter sends.

To support another PBX, implement `CallSession` for it and call `router.handleCall(session)` for each call. Nothing else changes.
