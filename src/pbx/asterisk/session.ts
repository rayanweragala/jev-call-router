import { CallEndedError, type CallAction, type CallInfo, type CallSession, type CallerAudio } from "../../types.ts";
import { AriRequestError, type AriClient, type AriEvent, type Query } from "./ari.ts";
import { parseDialplanTarget } from "./dialplan.ts";

export interface RecordingOptions {
  maxSeconds: number;
  maxSilenceSeconds: number;
}

export interface AsteriskSession extends CallSession {
  answer(): Promise<void>;
  dispatch(event: AriEvent): void;
  end(error?: Error): void;
}

interface Waiter {
  match: (event: AriEvent) => boolean;
  resolve: (event: AriEvent) => void;
  reject: (error: Error) => void;
}

export function createAsteriskSession(
  ari: AriClient,
  call: CallInfo,
  recording: RecordingOptions,
): AsteriskSession {
  const channelPath = `/channels/${encodeURIComponent(call.id)}`;
  const waiters = new Set<Waiter>();
  let ended = false;
  let recordings = 0;

  function waitFor(match: (event: AriEvent) => boolean): Promise<AriEvent> {
    if (ended) {
      return Promise.reject(new CallEndedError(call.id));
    }
    const promise = new Promise<AriEvent>((resolve, reject) => {
      waiters.add({ match, resolve, reject });
    });
    promise.catch(() => {});
    return promise;
  }

  async function channelRequest(method: "POST" | "DELETE", suffix: string, query?: Query) {
    if (ended) {
      throw new CallEndedError(call.id);
    }
    try {
      return await ari.request(method, `${channelPath}${suffix}`, query);
    } catch (error) {
      if (error instanceof AriRequestError && error.status === 404) {
        throw new CallEndedError(call.id);
      }
      throw error;
    }
  }

  async function answer(): Promise<void> {
    await channelRequest("POST", "/answer");
  }

  async function play(media: string): Promise<void> {
    const playbackId = crypto.randomUUID();
    const finished = waitFor(
      (event) => event.type === "PlaybackFinished" && event.playback?.id === playbackId,
    );
    await channelRequest("POST", `/play/${playbackId}`, { media });
    const event = await finished;
    if (event.playback?.state === "failed") {
      throw new Error(`Playback of ${media} failed`);
    }
  }

  async function recordUtterance(): Promise<CallerAudio | undefined> {
    recordings += 1;
    const name = `jev-${call.id}-${recordings}`;
    const finished = waitFor(
      (event) =>
        (event.type === "RecordingFinished" || event.type === "RecordingFailed") &&
        event.recording?.name === name,
    );
    await channelRequest("POST", "/record", {
      name,
      format: "wav",
      maxDurationSeconds: recording.maxSeconds,
      maxSilenceSeconds: recording.maxSilenceSeconds,
      beep: false,
      ifExists: "overwrite",
      terminateOn: "#",
    });
    const event = await finished;
    if (event.type === "RecordingFailed") {
      throw new Error(`Recording failed: ${event.recording?.cause ?? "unknown cause"}`);
    }
    try {
      return isSilent(event) ? undefined : await downloadRecording(name);
    } finally {
      await deleteRecording(name);
    }
  }

  async function downloadRecording(name: string): Promise<CallerAudio> {
    const response = await ari.request("GET", `/recordings/stored/${encodeURIComponent(name)}/file`);
    return { data: new Uint8Array(await response.arrayBuffer()), mimeType: "audio/wav" };
  }

  async function deleteRecording(name: string): Promise<void> {
    await ari.request("DELETE", `/recordings/stored/${encodeURIComponent(name)}`).catch(() => {});
  }

  async function execute(action: CallAction): Promise<void> {
    if (action.type === "hangup") {
      await channelRequest("DELETE", "");
      return;
    }
    if (action.type === "continue") {
      await channelRequest("POST", "/continue");
      return;
    }
    const target = parseDialplanTarget(action.destination);
    await channelRequest("POST", "/continue", {
      context: target.context,
      extension: target.extension,
      priority: target.priority,
      label: target.label,
    });
  }

  function dispatch(event: AriEvent): void {
    for (const waiter of waiters) {
      if (waiter.match(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }

  function end(error: Error = new CallEndedError(call.id)): void {
    if (error instanceof CallEndedError) {
      ended = true;
    }
    for (const waiter of waiters) {
      waiter.reject(error);
    }
    waiters.clear();
  }

  return { call, answer, play, recordUtterance, execute, dispatch, end };
}

function isSilent(event: AriEvent): boolean {
  const talking = event.recording?.talking_duration;
  const duration = event.recording?.duration;
  return talking === 0 || duration === 0;
}
