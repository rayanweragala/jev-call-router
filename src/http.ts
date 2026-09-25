import { eventHub } from "./events.ts";
import { silentLogger } from "./logger.ts";
import type { CallRouter } from "./router.ts";
import { createScriptedSession } from "./testing.ts";
import type { CallInfo, Logger } from "./types.ts";

export interface HttpServerOptions {
  router: CallRouter;
  port?: number;
  logger?: Logger;
}

export function startHttpServer(options: HttpServerOptions) {
  const port = options.port ?? (Number(process.env.PORT) || 3000);
  const logger = options.logger ?? silentLogger;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/events") {
        return handleSseStream();
      }

      if (url.pathname === "/simulate" && req.method === "POST") {
        return handleSimulate(req, options.router);
      }

      if (url.pathname === "/api/health") {
        return Response.json({ status: "ok", subscribers: eventHub.subscriberCount });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return servePublicFile("public/index.html");
      }

      if (url.pathname.startsWith("/")) {
        const potentialPath = `public${url.pathname}`;
        const file = Bun.file(potentialPath);
        if (await file.exists()) {
          return new Response(file);
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info("http.server_started", { port: server.port, url: `http://localhost:${server.port}` });
  return server;
}

function handleSseStream(): Response {
  let unsubscribe: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`),
      );

      unsubscribe = eventHub.subscribe((event) => {
        try {
          const payload = `event: ${event.event}\ndata: ${JSON.stringify({ ...event.data, timestamp: event.timestamp })}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          unsubscribe?.();
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleSimulate(req: Request, router: CallRouter): Promise<Response> {
  try {
    const body = (await req.json()) as { utterance?: string; utterances?: string[]; caller?: string };
    const utterances = body.utterances ?? (body.utterance ? [body.utterance] : ["I want to know about your products"]);
    const callInfo: CallInfo = {
      id: `simulated-${Date.now()}`,
      caller: body.caller ?? "+15552345678",
      variables: {},
    };
    const session = createScriptedSession(callInfo, utterances);
    const result = await router.handleCall(session);
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

async function servePublicFile(filePath: string): Promise<Response> {
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response(defaultHtmlPlaceholder(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function defaultHtmlPlaceholder(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>jev-call-router • Live Visualizer</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-xl p-6 text-center space-y-4">
    <div class="inline-flex p-3 rounded-full bg-blue-500/10 text-blue-400">
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" /></svg>
    </div>
    <h1 class="text-xl font-semibold">jev-call-router Visualizer</h1>
    <p class="text-sm text-slate-400">SSE server is running. Place your generated UI file at <code class="text-blue-400 bg-slate-800 px-1 py-0.5 rounded">public/index.html</code> to view the full animated dispatcher.</p>
    <div class="pt-2">
      <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
        SSE Endpoint: /events
      </span>
    </div>
  </div>
</body>
</html>`;
}
