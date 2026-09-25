import type { Logger } from "./types.ts";

type Level = "info" | "warn" | "error";

export function createJsonLogger(write: (line: string) => void = console.log): Logger {
  const log = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    write(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  };
  return {
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
