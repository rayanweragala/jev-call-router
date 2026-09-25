import { ConfigError } from "../../config.ts";
import type { Route } from "../../types.ts";

export interface DialplanTarget {
  context: string;
  extension: string;
  priority?: number;
  label?: string;
}

export function parseDialplanTarget(destination: string): DialplanTarget {
  const parts = destination.split(",").map((part) => part.trim());
  const [context, extension, position = "1"] = parts;
  if (parts.length > 3 || !context || !extension || !position) {
    throw new ConfigError(
      `Invalid Asterisk destination "${destination}". Use "context,extension" or "context,extension,priority".`,
    );
  }
  if (/^\d+$/.test(position)) {
    return { context, extension, priority: Number(position) };
  }
  return { context, extension, label: position };
}

export function validateAsteriskRoutes(routes: Record<string, Route>): void {
  for (const route of Object.values(routes)) {
    if (route.action.type === "transfer") {
      parseDialplanTarget(route.action.destination);
    }
  }
}
