# Integration guide

This guide connects jev-call-router to a real phone system across three configuration areas:

| Area | Where | What |
|---|---|---|
| External providers | vendor dashboards | TypeSafe (Jev) key, speech-to-text key, optional Anthropic key |
| PBX | Asterisk / FreePBX | ARI user, one dialplan context, prompt recordings, inbound routing |
| Application | this repo: `router.config.ts`, `.env` | routes, prompts, fallback, thresholds, provider keys |

## How the pieces talk

```
Caller ──SIP/PSTN──▶ Asterisk ──Stasis(jev-router)──▶ ARI WebSocket events ──▶ jev-call-router
                        ▲                                                       │
                        └──── ARI REST: answer, play, record, continue ◀───────┘
                                                                                ├─▶ speech-to-text API
                                                                                └─▶ Jev (api.typesafe.ai)
```

The router opens one outbound WebSocket to Asterisk (`/ari/events?app=jev-router`) and makes REST calls to it. Asterisk never calls the router, so the router can run on the PBX host or on another machine that can reach port 8088.

For each call the adapter:

1. receives `StasisStart` and answers the channel,
2. plays your greeting (`POST /channels/{id}/play`),
3. records the caller until 2 s of silence, 15 s max, or `#` (`POST /channels/{id}/record`),
4. downloads and deletes the recording (`/recordings/stored/{name}/file`),
5. sends the audio to speech-to-text and the text to Jev,
6. plays the route's announcement, if any,
7. calls `POST /channels/{id}/continue?context=…&extension=…&priority=…`, which leaves Stasis and resumes the dialplan at the chosen destination.

## External providers

1. Jev / TypeSafe: Create an API key in your TypeSafe account ([docs.typesafe.ai](https://docs.typesafe.ai)) and add it to `.env` as `TYPESAFE_API_KEY`.
2. Speech-to-text: Any service with an OpenAI-style `POST {base}/audio/transcriptions` endpoint (multipart `file` + `model`, JSON `{ "text": … }` response) works. Set `STT_API_KEY`, `STT_BASE_URL` (for example `https://api.openai.com/v1`), and `STT_MODEL` to a transcription model your provider offers. Asterisk records 8 kHz mono WAV, which these services accept.
3. Optional interpreter: To send Jev a short summary with personal details removed instead of the raw transcript, add `interpreter: createClaudeInterpreter()` to your config and set `ANTHROPIC_API_KEY`. It uses `claude-opus-5` at low effort, with server-side refusal fallbacks enabled. It adds one model call of latency per attempt.

The router's host needs outbound HTTPS to `api.typesafe.ai`, your STT host, and (optionally) `api.anthropic.com`.

## PBX configuration

### Plain Asterisk

1. Enable the HTTP server and ARI: See [`examples/asterisk/http.conf`](../examples/asterisk/http.conf) and [`examples/asterisk/ari.conf`](../examples/asterisk/ari.conf). Bind to `127.0.0.1` if the router runs on the same host. Otherwise bind to a private interface and enable TLS.
2. Add the dialplan context from [`examples/asterisk/extensions_custom.conf`](../examples/asterisk/extensions_custom.conf) and send calls into it, for example:

   ```
   [from-pstn]
   exten => 8000,1,Goto(jev-router,s,1)
   ```

3. Record prompts: Put `jev-greeting`, `jev-retry`, and `jev-connecting` (WAV or ulaw) in `/var/lib/asterisk/sounds/custom/`. They are referenced as `sound:custom/jev-greeting`.
4. Reload and check:

   ```
   asterisk -rx "module reload res_ari.so"
   asterisk -rx "dialplan reload"
   asterisk -rx "http show status"     # ARI under /ari
   asterisk -rx "ari show users"       # your ARI user
   asterisk -rx "ari show apps"        # jev-router appears once `bun start` is running
   ```

### FreePBX

FreePBX runs Asterisk, so it uses the same ARI adapter with no FreePBX-specific code. Configuration locations differ because FreePBX regenerates most `.conf` files:

1. ARI user: Do not edit `ari.conf` directly. In Settings > Advanced Settings, confirm that the Asterisk mini-HTTP server and the Asterisk REST Interface are enabled, and note the ARI credentials. Alternatively, add a `[jev]` user block to `/etc/asterisk/ari_additional_custom.conf`. Verify with `asterisk -rx "ari show users"`.
2. Dialplan: Paste the `[jev-router]` context into `/etc/asterisk/extensions_custom.conf`, then run `fwconsole reload`.
3. Custom Destination: Under Admin > Custom Destinations > Add, set target to `jev-router,s,1` and description to "Jev router".
4. Inbound routes: In Connectivity > Inbound Routes, set the destination of DIDs using Jev to the "Jev router" Custom Destination. All other routes remain unchanged.
5. Prompts: In Admin > System Recordings, create `jev-greeting`, `jev-retry`, and `jev-connecting`. FreePBX stores them under `custom/`, so they are referenced as `sound:custom/jev-greeting`.
6. Route destinations: In `router.config.ts`, route actions map to FreePBX contexts:

   | FreePBX destination | Action destination |
   |---|---|
   | Queue 400 | `ext-queues,400,1` |
   | Ring group 600 | `ext-group,600,1` |
   | Extension 100 | `from-did-direct,100,1` |
   | Voicemail of 100 (unavailable greeting) | `ext-local,vmu100,1` |
   | IVR 3 | `ivr-3,s,1` |
   | Hang up | use `{ type: "hangup" }` |

   To verify the context of a destination, run `asterisk -rx "dialplan show <context>"`.

### Dialplan fallback destination

The line after `Stasis()` in `[jev-router]` is the last-resort destination. The dialplan reaches it when:

- the router is not running or disconnected (`Stasis()` exits with `STASISSTATUS=FAILED`),
- a route uses `{ type: "continue" }`, or
- the router fails to execute both the chosen route and the fallback route.

Point this destination at an attended extension or staffed queue.

## Application configuration

Everything lives in [`router.config.ts`](../router.config.ts):

```ts
export const routes: Record<string, Route> = {
  billing: {
    description: "Questions about invoices, charges, refunds, payments.",   // offered to Jev
    action: { type: "transfer", destination: "ext-queues,402,1" },
  },
  "human-agent": {
    description: "The caller asks for a person.",
    action: { type: "transfer", destination: "from-did-direct,100,1" },
    announcement: "sound:custom/jev-connecting",
  },
  "standard-ivr": { action: { type: "continue" } },                         // not offered to Jev
};
export const fallbackRoute = "human-agent";
```

Options on `createCallRouter`:

| Option | Default | Meaning |
|---|---|---|
| `routes` | required | Your outcomes. Only routes with `description` are offered to Jev |
| `fallbackRoute` | required | Route used whenever routing cannot complete safely |
| `prompts.greeting` / `prompts.retry` | required / greeting | PBX media played before listening |
| `maxAttempts` | `2` | How many times to listen before falling back |
| `minConfidence` | `0.7` | Jev confidence required to act; tune on your own calls |
| `timeouts` | STT 8 s, interpreter 6 s, Jev 5 s | Each stage falls back when exceeded |
| `routeDirectly(call)` | none | Return a route name to skip Jev for this call |
| `facts(call)` | none | Extra facts for Jev, for example `{ afterHours: true }` |
| `interpreter` | none | Summarize the transcript before Jev sees it |
| `onResult(result)` | none | Receives each `RoutingResult`. Use it for webhooks, metrics, or audit logs |
| `logger` | silent | `createJsonLogger()` writes JSON lines to stdout |

### Passing information from the dialplan

Arguments after the app name in `Stasis()` become `call.variables` when they are `key=value`:

```
same => n,Stasis(jev-router,line=support,jev=${JEV_ENABLED})
```

```ts
routeDirectly: (call) => (call.variables.jev === "off" ? "standard-ivr" : undefined),
facts: (call) => ({ line: call.variables.line ?? "main" }),
```

`call.caller` (caller ID) and `call.dialed` (the dialed extension) are also available to your rules. They are not sent to Jev unless you put them in `facts`.

### Asterisk adapter options

`connectAsterisk({ url, username, password, app, router, recording: { maxSeconds, maxSilenceSeconds }, reconnectDelayMs, logger })`. `bun start` (`src/server.ts`) wires this up from `.env`. At startup it validates every `transfer` destination and fails fast on a malformed one. If the event WebSocket drops, the adapter reconnects every 3 s. Calls in progress fall back through ARI REST.

## Trying it without a PBX

```bash
bun run simulate "my internet has been down since this morning"
```

This runs the real call flow with a scripted session: text stands in for audio, and actions are printed instead of executed. The router still calls the real Jev API.

## Verification status

- Verified locally: the router core, all fallback paths, and the ARI adapter against a mock ARI server that uses the real endpoint shapes and events (`bun test`). Also verified: the full `bun start` service against a mock ARI server and a mock STT server, `.env` loading, ARI reconnection, and that logs contain no secrets or caller numbers.
- Remaining on-call verification: real audio through `record` and `play`, silence detection values (`talking_duration`), FreePBX Advanced Settings names for ARI, the `continue` behavior into your specific FreePBX destinations, and end-to-end latency on a live call. Test with an internal extension first. Start with a high `minConfidence` and a staffed `fallbackRoute`, and review the `fallback.triggered` logs.
