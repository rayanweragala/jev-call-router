import {
  createJevDecider,
  createTranscriptionSpeech,
  requireEnv,
  type CallRouterConfig,
  type Logger,
  type Route,
} from "./src/index.ts";

export const routes: Record<string, Route> = {
  sales: {
    description: "New or prospective customers asking about products, pricing, quotes, or purchasing.",
    action: { type: "transfer", destination: "ext-queues,400,1" },
  },
  support: {
    description: "Existing customers reporting technical issues or service outages.",
    action: { type: "transfer", destination: "ext-queues,401,1" },
  },
  billing: {
    description: "Questions about invoices, charges, refunds, payments, or changing a payment method.",
    action: { type: "transfer", destination: "ext-queues,402,1" },
  },
  voicemail: {
    description: "The caller wants to leave a voicemail message.",
    action: { type: "transfer", destination: "ext-local,vmu100,1" },
  },
  "human-agent": {
    description: "The caller asks for a person, operator, or front desk.",
    action: { type: "transfer", destination: "from-did-direct,100,1" },
    announcement: "sound:custom/jev-connecting",
  },
  "standard-ivr": {
    action: { type: "continue" },
  },
};

export const fallbackRoute = "human-agent";

export const prompts = {
  greeting: "sound:custom/jev-greeting",
  retry: "sound:custom/jev-retry",
};

export function createRouterConfig(logger: Logger): CallRouterConfig {
  return {
    decider: createJevDecider({
      apiKey: requireEnv("TYPESAFE_API_KEY"),
      model: process.env.TYPESAFE_DEFAULT_MODEL,
    }),
    speech: createTranscriptionSpeech({
      apiKey: requireEnv("STT_API_KEY"),
      baseUrl: requireEnv("STT_BASE_URL"),
      model: requireEnv("STT_MODEL"),
      language: process.env.STT_LANGUAGE,
    }),
    routes,
    fallbackRoute,
    prompts,
    maxAttempts: 2,
    minConfidence: 0.7,
    routeDirectly: (call) => (call.variables.jev === "off" ? "standard-ivr" : undefined),
    logger,
  };
}
