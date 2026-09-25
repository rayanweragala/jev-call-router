import { fallbackRoute, prompts, routes } from "../router.config.ts";
import { requireEnv } from "./config.ts";
import { startHttpServer } from "./http.ts";
import { createJevDecider } from "./jev.ts";
import { createJsonLogger, describeError } from "./logger.ts";
import { createCallRouter } from "./router.ts";
import { textSpeech } from "./testing.ts";
import { sendWebhook } from "./webhook.ts";

const logger = createJsonLogger();

function start(): void {
  const router = createCallRouter({
    decider: createJevDecider({
      apiKey: requireEnv("TYPESAFE_API_KEY"),
      model: process.env.TYPESAFE_DEFAULT_MODEL,
    }),
    speech: textSpeech,
    routes,
    fallbackRoute,
    prompts,
    maxAttempts: 2,
    minConfidence: 0.7,
    routeDirectly: (call) => (call.variables.jev === "off" ? "standard-ivr" : undefined),
    onResult: (result) => {
      if (process.env.WEBHOOK_URL) {
        void sendWebhook(result, {
          url: process.env.WEBHOOK_URL,
          secret: process.env.WEBHOOK_SECRET,
          logger,
        });
      }
    },
    logger,
  });

  const port = Number(process.env.PORT) || 3000;
  const server = startHttpServer({ router, port, logger });
  logger.info("demo.ready", {
    url: `http://localhost:${server.port}`,
    message: "Open this URL in your browser to view the live visualizer",
  });

  const stop = () => {
    logger.info("demo.stopping");
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

try {
  start();
} catch (error) {
  logger.error("demo.start_failed", { error: describeError(error) });
  process.exit(1);
}
