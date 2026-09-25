import {
  createClaudeInterpreter,
  createJevDecider,
  createTranscriptionSpeech,
  requireEnv,
  type CallRouterConfig,
  type Route,
} from "../src/index.ts";

const speech = createTranscriptionSpeech({
  apiKey: requireEnv("STT_API_KEY"),
  baseUrl: requireEnv("STT_BASE_URL"),
  model: requireEnv("STT_MODEL"),
});
const decider = createJevDecider({ apiKey: requireEnv("TYPESAFE_API_KEY") });
const queue = (id: string): Route["action"] => ({ type: "transfer", destination: `ext-queues,${id},1` });

export const smallBusiness: CallRouterConfig = {
  decider,
  speech,
  routes: {
    bookings: { description: "Booking, moving, or cancelling an appointment.", action: queue("300") },
    questions: { description: "General questions about opening hours, location, or services.", action: queue("301") },
    reception: { action: { type: "transfer", destination: "from-did-direct,100,1" } },
  },
  fallbackRoute: "reception",
  prompts: { greeting: "sound:custom/jev-greeting" },
};

const vipNumbers = new Set(["+15550001111", "+15550002222"]);

export const saasSupportDesk: CallRouterConfig = {
  decider,
  speech,
  routes: {
    sales: { description: "Prospective customers asking about plans, pricing, demos, or buying.", action: queue("400") },
    support: { description: "Customers reporting bugs, outages, or service disruptions.", action: queue("401") },
    billing: { description: "Invoices, charges, refunds, or payment methods.", action: queue("402") },
    "vip-support": { action: queue("410"), announcement: "sound:custom/vip-priority" },
    "human-agent": { description: "Caller asks for a person or operator.", action: queue("499") },
  },
  fallbackRoute: "human-agent",
  prompts: { greeting: "sound:custom/jev-greeting", retry: "sound:custom/jev-retry" },
  routeDirectly: (call) => (call.caller && vipNumbers.has(call.caller) ? "vip-support" : undefined),
};

const isBusinessHours = () => {
  const hour = new Date().getHours();
  return hour >= 9 && hour < 17;
};

export const afterHoursAware: CallRouterConfig = {
  decider,
  speech,
  routes: {
    "urgent-on-call": {
      description: "Urgent issues requiring immediate response, such as a complete outage.",
      action: { type: "transfer", destination: "ext-group,600,1" },
    },
    callback: {
      description: "Requests for a telephone callback.",
      action: { type: "transfer", destination: "callback-request,s,1" },
      announcement: "sound:custom/we-will-call-you-back",
    },
    voicemail: {
      description: "The caller wants to leave a message.",
      action: { type: "transfer", destination: "ext-local,vmu100,1" },
    },
    "day-ivr": { action: { type: "continue" } },
  },
  fallbackRoute: "voicemail",
  prompts: { greeting: "sound:custom/after-hours-greeting" },
  routeDirectly: () => (isBusinessHours() ? "day-ivr" : undefined),
  facts: () => ({ afterHours: !isBusinessHours() }),
  minConfidence: 0.8,
};

export const privacyFirst: CallRouterConfig = {
  ...smallBusiness,
  interpreter: createClaudeInterpreter(),
  timeouts: { interpreterMs: 4000, decisionMs: 3000 },
};

export const selectedLinesOnly: CallRouterConfig = {
  ...smallBusiness,
  routes: { ...smallBusiness.routes, "standard-ivr": { action: { type: "continue" } } },
  routeDirectly: (call) => (call.variables.line === "sales-line" ? undefined : "standard-ivr"),
};
