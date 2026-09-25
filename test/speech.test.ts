import { describe, expect, test } from "bun:test";
import { createTranscriptionSpeech } from "../src/index.ts";

const audio = { data: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" };

describe("transcription API speech provider", () => {
  test("uploads the recording and returns the transcript", async () => {
    let seen: { url: string; auth: string | null; form: FormData } | undefined;
    const speech = createTranscriptionSpeech({
      apiKey: "stt-secret",
      baseUrl: "https://stt.example.com/v1/",
      model: "stt-model",
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, auth: new Headers(init.headers).get("Authorization"), form: init.body as FormData };
        return Response.json({ text: " I need help with my bill " });
      }) as typeof fetch,
    });

    const text = await speech.transcribe(audio, new AbortController().signal);

    expect(text).toBe(" I need help with my bill ");
    expect(seen?.url).toBe("https://stt.example.com/v1/audio/transcriptions");
    expect(seen?.auth).toBe("Bearer stt-secret");
    expect(seen?.form.get("model")).toBe("stt-model");
    expect((seen?.form.get("file") as File).name).toBe("utterance.wav");
  });

  test("reports HTTP failures without leaking the API key", async () => {
    const speech = createTranscriptionSpeech({
      apiKey: "stt-secret",
      baseUrl: "https://stt.example.com/v1",
      model: "stt-model",
      fetch: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    });

    const error = await speech.transcribe(audio, new AbortController().signal).catch((e: Error) => e);

    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain("stt-secret");
  });
});
