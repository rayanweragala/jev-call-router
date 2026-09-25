import type { CallAction, CallInfo, CallSession, CallerAudio, SpeechToText } from "./types.ts";

export interface ScriptedSession extends CallSession {
  played: string[];
  executed: CallAction[];
}

export function createScriptedSession(call: CallInfo, utterances: (string | undefined)[]): ScriptedSession {
  const remaining = [...utterances];
  const played: string[] = [];
  const executed: CallAction[] = [];
  return {
    call,
    played,
    executed,
    async play(media) {
      played.push(media);
    },
    async recordUtterance(): Promise<CallerAudio | undefined> {
      const text = remaining.shift();
      if (text === undefined) {
        return undefined;
      }
      return { data: new TextEncoder().encode(text), mimeType: "text/plain" };
    },
    async execute(action) {
      executed.push(action);
    },
  };
}

export const textSpeech: SpeechToText = {
  async transcribe(audio) {
    return new TextDecoder().decode(audio.data);
  },
};
