import { describeError, silentLogger } from "../../logger.ts";
import type { CallRouter } from "../../router.ts";
import type { CallInfo, Logger } from "../../types.ts";
import { createAriClient, type AriChannel, type AriEvent, type AriOptions } from "./ari.ts";
import { createAsteriskSession, type AsteriskSession, type RecordingOptions } from "./session.ts";

export interface AsteriskAdapterOptions extends AriOptions {
  router: CallRouter;
  recording?: Partial<RecordingOptions>;
  reconnectDelayMs?: number;
  logger?: Logger;
}

export interface AsteriskConnection {
  close(): void;
}

const DEFAULT_RECORDING: RecordingOptions = { maxSeconds: 15, maxSilenceSeconds: 2 };
const CALL_END_EVENTS = new Set(["StasisEnd", "ChannelDestroyed", "ChannelHangupRequest"]);

export function connectAsterisk(options: AsteriskAdapterOptions): AsteriskConnection {
  const ari = createAriClient(options);
  const logger = options.logger ?? silentLogger;
  const recording = { ...DEFAULT_RECORDING, ...options.recording };
  const sessions = new Map<string, AsteriskSession>();
  let socket: WebSocket | undefined;
  let closed = false;

  function connect(): void {
    socket = ari.openEvents();
    socket.addEventListener("open", () => logger.info("asterisk.connected", { app: options.app }));
    socket.addEventListener("message", (message) => handleMessage(message.data));
    socket.addEventListener("error", () => logger.error("asterisk.socket_error", { app: options.app }));
    socket.addEventListener("close", handleClose);
  }

  function handleClose(): void {
    const lost = new Error("Lost the ARI event connection");
    for (const session of sessions.values()) {
      session.end(lost);
    }
    if (closed) {
      return;
    }
    logger.warn("asterisk.disconnected", { app: options.app });
    setTimeout(connect, options.reconnectDelayMs ?? 3000);
  }

  function handleMessage(data: unknown): void {
    let event: AriEvent;
    try {
      event = JSON.parse(String(data)) as AriEvent;
    } catch {
      logger.warn("asterisk.invalid_event");
      return;
    }
    if (event.type === "StasisStart" && event.channel) {
      startCall(event.channel, event.args ?? []);
      return;
    }
    dispatch(event);
  }

  function startCall(channel: AriChannel, args: string[]): void {
    if (sessions.has(channel.id)) {
      return;
    }
    const session = createAsteriskSession(ari, toCallInfo(channel, args), recording);
    sessions.set(channel.id, session);
    void runCall(session).finally(() => sessions.delete(channel.id));
  }

  async function runCall(session: AsteriskSession): Promise<void> {
    try {
      await session.answer();
    } catch (error) {
      logger.warn("asterisk.answer_failed", { callId: session.call.id, error: describeError(error) });
    }
    await options.router.handleCall(session);
  }

  function dispatch(event: AriEvent): void {
    const channelId = channelIdOf(event);
    const session = channelId ? sessions.get(channelId) : undefined;
    if (!session) {
      return;
    }
    if (CALL_END_EVENTS.has(event.type)) {
      session.end();
      return;
    }
    session.dispatch(event);
  }

  connect();

  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
}

export function toCallInfo(channel: AriChannel, args: string[]): CallInfo {
  return {
    id: channel.id,
    caller: channel.caller?.number || undefined,
    dialed: channel.dialplan?.exten || undefined,
    variables: parseStasisArgs(args),
  };
}

export function parseStasisArgs(args: string[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator > 0) {
      variables[arg.slice(0, separator).trim()] = arg.slice(separator + 1).trim();
    }
  }
  return variables;
}

function channelIdOf(event: AriEvent): string | undefined {
  if (event.channel) {
    return event.channel.id;
  }
  const target = event.playback?.target_uri ?? event.recording?.target_uri;
  if (target?.startsWith("channel:")) {
    return target.slice("channel:".length);
  }
  return undefined;
}
