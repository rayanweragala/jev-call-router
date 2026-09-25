import type { CallRouterConfig, Route, Timeouts } from "./types.ts";

export const NEED_MORE_INFORMATION = "need-more-information";
export const NO_MATCHING_ROUTE = "no-matching-route";

const RESERVED_ROUTE_NAMES = [NEED_MORE_INFORMATION, NO_MATCHING_ROUTE];
const ROUTE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const DEFAULT_TIMEOUTS: Timeouts = {
  speechMs: 8000,
  interpreterMs: 6000,
  decisionMs: 5000,
};

export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_MIN_CONFIDENCE = 0.7;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function validateConfig(config: CallRouterConfig): void {
  const names = Object.keys(config.routes);
  if (names.length === 0) {
    throw new ConfigError("At least one route is required.");
  }
  for (const name of names) {
    validateRoute(name, config.routes[name]!);
  }
  if (jevRouteNames(config.routes).length === 0) {
    throw new ConfigError("At least one route needs a description so Jev can choose it.");
  }
  if (!config.routes[config.fallbackRoute]) {
    throw new ConfigError(`fallbackRoute "${config.fallbackRoute}" is not a defined route.`);
  }
  if (!config.prompts.greeting.trim()) {
    throw new ConfigError("prompts.greeting is required.");
  }
  validateNumbers(config);
}

export function jevRouteNames(routes: Record<string, Route>): string[] {
  return Object.keys(routes).filter((name) => Boolean(routes[name]!.description?.trim()));
}

function validateRoute(name: string, route: Route): void {
  if (!ROUTE_NAME_PATTERN.test(name)) {
    throw new ConfigError(`Route name "${name}" must use lowercase letters, digits, "-" or "_".`);
  }
  if (RESERVED_ROUTE_NAMES.includes(name)) {
    throw new ConfigError(`Route name "${name}" is reserved.`);
  }
  const action = route.action;
  if (action.type === "transfer" && !action.destination.trim()) {
    throw new ConfigError(`Route "${name}" has a transfer action without a destination.`);
  }
}

function validateNumbers(config: CallRouterConfig): void {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ConfigError("maxAttempts must be a positive integer.");
  }
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (minConfidence < 0 || minConfidence > 1) {
    throw new ConfigError("minConfidence must be between 0 and 1.");
  }
  for (const [name, value] of Object.entries(config.timeouts ?? {})) {
    if (!(value > 0)) {
      throw new ConfigError(`timeouts.${name} must be a positive number of milliseconds.`);
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(`Environment variable ${name} is not set. Add it to .env (see .env.example).`);
  }
  return value;
}
