import { silentLogger } from "./logger.ts";
import type { Logger, RoutingResult } from "./types.ts";

export interface WebhookConfig {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export async function sendWebhook(
  result: RoutingResult,
  config: WebhookConfig,
): Promise<void> {
  const url = config.url?.trim();
  if (!url) {
    return;
  }
  const logger = config.logger ?? silentLogger;
  const body = JSON.stringify({
    event: "call.result",
    timestamp: new Date().toISOString(),
    data: result,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "jev-call-router/0.1.0",
  };

  if (config.secret?.trim()) {
    try {
      headers["X-Jev-Signature"] = await generateSignature(body, config.secret.trim());
    } catch (err) {
      logger.warn("webhook.signature_error", { error: String(err) });
    }
  }

  const timeoutMs = config.timeoutMs ?? 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn("webhook.delivery_failed", {
        url,
        status: response.status,
        callId: result.callId,
      });
    } else {
      logger.info("webhook.delivered", {
        url,
        status: response.status,
        callId: result.callId,
      });
    }
  } catch (error) {
    logger.warn("webhook.delivery_error", {
      url,
      callId: result.callId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function generateSignature(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
