import { engine } from "./engine";

function pickMime(): string {
  const opts = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
  for (const m of opts) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "video/webm";
}

export const exportSupported = () =>
  typeof MediaRecorder !== "undefined" &&
  typeof HTMLCanvasElement !== "undefined" &&
  "captureStream" in HTMLCanvasElement.prototype;

export interface Recording {
  stop: () => Promise<Blob>;
}

/** Record a canvas + the live engine audio into a single webm. Returns a handle whose
 *  stop() resolves with the finished Blob. */
export function startRecording(canvas: HTMLCanvasElement, fps = 30): Recording {
  const mime = pickMime();
  const canvasStream = canvas.captureStream(fps);
  const audioStream = engine.captureStream();
  const tracks = [...canvasStream.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])];
  const stream = new MediaStream(tracks);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(100);

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
        rec.stop();
        canvasStream.getTracks().forEach((t) => t.stop());
      }),
  };
}

/** Trigger a download of a recorded blob (works in the browser + webviews). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
