import type { CallerAudio, SpeechToText } from "../types.ts";

export interface TranscriptionOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  language?: string;
  fetch?: typeof fetch;
}

export type TranscriptionApiOptions = TranscriptionOptions;

export function createTranscriptionSpeech(options: TranscriptionOptions): SpeechToText {
  const send = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  return {
    async transcribe(audio, signal) {
      const response = await send(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: buildForm(audio, options),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Transcription request failed with HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      return readText(body);
    },
  };
}

export const createTranscriptionApiSpeech = createTranscriptionSpeech;

function buildForm(audio: CallerAudio, options: TranscriptionApiOptions): FormData {
  const form = new FormData();
  form.append("file", new Blob([audio.data], { type: audio.mimeType }), fileNameFor(audio.mimeType));
  form.append("model", options.model);
  if (options.language) {
    form.append("language", options.language);
  }
  return form;
}

function fileNameFor(mimeType: string): string {
  if (mimeType.includes("wav")) {
    return "utterance.wav";
  }
  if (mimeType.includes("mpeg")) {
    return "utterance.mp3";
  }
  return "utterance.bin";
}

function readText(body: unknown): string {
  if (typeof body === "object" && body !== null && "text" in body && typeof body.text === "string") {
    return body.text;
  }
  throw new Error("Transcription response did not contain text");
}
