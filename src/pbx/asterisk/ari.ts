export interface AriOptions {
  url: string;
  username: string;
  password: string;
  app: string;
}

export interface AriChannel {
  id: string;
  name?: string;
  state?: string;
  caller?: { number?: string };
  dialplan?: { context?: string; exten?: string; priority?: number };
}

export interface AriEvent {
  type: string;
  application?: string;
  args?: string[];
  channel?: AriChannel;
  playback?: { id: string; target_uri?: string; state?: string };
  recording?: {
    name: string;
    target_uri?: string;
    state?: string;
    duration?: number;
    talking_duration?: number;
    cause?: string;
  };
}

export type Query = Record<string, string | number | boolean | undefined>;

export class AriRequestError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`ARI ${method} ${path} failed with HTTP ${status}`);
    this.name = "AriRequestError";
    this.status = status;
  }
}

export interface AriClient {
  request(method: "GET" | "POST" | "DELETE", path: string, query?: Query): Promise<Response>;
  openEvents(): WebSocket;
}

export function createAriClient(options: AriOptions): AriClient {
  const baseUrl = options.url.replace(/\/+$/, "");
  const authorization = `Basic ${btoa(`${options.username}:${options.password}`)}`;

  async function request(method: "GET" | "POST" | "DELETE", path: string, query: Query = {}) {
    const url = new URL(`${baseUrl}/ari${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, { method, headers: { Authorization: authorization } });
    if (!response.ok) {
      throw new AriRequestError(method, path, response.status);
    }
    return response;
  }

  function openEvents(): WebSocket {
    const url = new URL(`${baseUrl}/ari/events`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("app", options.app);
    return new WebSocket(url.toString(), { headers: { Authorization: authorization } });
  }

  return { request, openEvents };
}
