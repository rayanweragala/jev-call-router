import { fallbackRoute, prompts, routes } from "../router.config.ts";
import {
  createCallRouter,
  createJevDecider,
  createJsonLogger,
  createScriptedSession,
  requireEnv,
  textSpeech,
} from "../src/index.ts";

const utterances = process.argv.slice(2);
if (utterances.length === 0) {
  console.error('Usage: bun run simulate "what the caller says" ["what they say after the retry prompt"]');
  process.exit(1);
}

const router = createCallRouter({
  decider: createJevDecider({ apiKey: requireEnv("TYPESAFE_API_KEY") }),
  speech: textSpeech,
  routes,
  fallbackRoute,
  prompts,
  logger: createJsonLogger(console.error),
});

const session = createScriptedSession({ id: `simulated-${Date.now()}`, variables: {} }, utterances);
const result = await router.handleCall(session);
console.log(JSON.stringify({ played: session.played, executed: session.executed, result }, null, 2));
