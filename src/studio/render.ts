import type { Film } from "./model";
import { getSourceBlob } from "../lib/storage";

type Frame = {
  image?: ImageBitmap;
  video?: HTMLVideoElement;
  url?: string;
  caption: string;
};
function lines(ctx: CanvasRenderingContext2D, value: string, max: number) {
  const result: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/)) {
    if (ctx.measureText(`${line} ${word}`).width > max && line) {
      result.push(line);
      line = word;
    } else line += `${line ? " " : ""}${word}`;
  }
  if (line) result.push(line);
  return result;
}
async function loadVideo(blob: Blob): Promise<Frame> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "A video source took too long to load. Try a smaller MP4 file.",
            ),
          ),
        20_000,
      );
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(
          new Error(
            "One of the video sources could not be decoded. Try an MP4 file.",
          ),
        );
      };
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { video, url, caption: "Family footage" };
}
export function supportedMime() {
  if (typeof MediaRecorder === "undefined") return "";
  return (
    [
      "video/mp4;codecs=avc1.42001E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m)) || ""
  );
}

export async function renderFilm(
  film: Film,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  onProgress: (value: number, message: string) => void,
): Promise<Blob> {
  const mimeType = supportedMime();
  if (!mimeType || !canvas.captureStream)
    throw new Error(
      "This browser cannot export films. Open Lineage Theatre in current Chrome or Edge.",
    );
  if (!film.scenes.length) throw new Error("Build your scene plan first.");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const frames: Frame[] = [];
  const mediaCache = new Map<string, Frame>();
  const audio = new AudioContext();
  const destination = audio.createMediaStreamDestination();
  let stream: MediaStream | undefined;
  let recording: MediaRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let wakeLock: { release(): Promise<void> } | undefined;
  try {
    await audio.resume();
    if ("wakeLock" in navigator) {
      try {
        wakeLock = await (
          navigator as Navigator & {
            wakeLock: {
              request(t: string): Promise<{ release(): Promise<void> }>;
            };
          }
        ).wakeLock.request("screen");
      } catch {
        /* export still works */
      }
    }
    onProgress(0, "Preparing your family archive…");
    for (const scene of film.scenes) {
      if (signal.aborted)
        throw new DOMException("Export cancelled", "AbortError");
      if (scene.shot?.status === "completed" && scene.shot.videoUrl) {
        const response = await fetch(scene.shot.videoUrl, { signal });
        if (!response.ok)
          throw new Error(
            "A generated shot could not be loaded. Refresh its status before exporting.",
          );
        const frame = await loadVideo(await response.blob());
        frame.caption = "AI dramatization";
        frames.push(frame);
        continue;
      }
      const source =
        film.sources.find(
          (s) =>
            scene.sourceIds.includes(s.id) && /^(image|video)\//.test(s.type),
        ) ||
        film.sources.filter((s) => /^(image|video)\//.test(s.type))[
          frames.length %
            Math.max(
              1,
              film.sources.filter((s) => /^(image|video)\//.test(s.type))
                .length,
            )
        ];
      if (source) {
        if (!mediaCache.has(source.id)) {
          const blob = await getSourceBlob(source.id);
          if (!blob)
            throw new Error(
              `${source.name} is missing from this browser. Add the source again before exporting.`,
            );
          const frame = source.type.startsWith("video")
            ? await loadVideo(blob)
            : { image: await createImageBitmap(blob), caption: "" };
          frame.caption = source.name;
          mediaCache.set(source.id, frame);
        }
        frames.push(mediaCache.get(source.id)!);
      } else frames.push({ caption: "Family story · title sequence" });
    }
    const soundtrack = film.audioId ? await getSourceBlob(film.audioId) : null;
    if (film.audioId && !soundtrack)
      throw new Error(
        "The selected narration is missing. Choose another recording.",
      );
    let sound: AudioBufferSourceNode | undefined;
    if (soundtrack) {
      sound = audio.createBufferSource();
      sound.buffer = await audio.decodeAudioData(
        await soundtrack.arrayBuffer(),
      );
      sound.connect(destination);
    }
    if (film.music) {
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0, audio.currentTime);
      gain.gain.linearRampToValueAtTime(
        soundtrack ? 0.012 : 0.035,
        audio.currentTime + 2,
      );
      gain.gain.setValueAtTime(
        soundtrack ? 0.012 : 0.035,
        audio.currentTime + film.duration - 2,
      );
      gain.gain.linearRampToValueAtTime(0, audio.currentTime + film.duration);
      gain.connect(destination);
      for (const [index, hz] of [130.81, 196, 261.63, 329.63].entries()) {
        const oscillator = audio.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = hz;
        oscillator.detune.value = index % 2 ? 2 : -2;
        oscillator.connect(gain);
        oscillator.start();
        oscillator.stop(audio.currentTime + film.duration);
      }
    }
    // A silent audio track also gives the recording a stable time base.
    stream = canvas.captureStream(30);
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    recording = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 5_000_000,
      audioBitsPerSecond: 128000,
    });
    const chunks: BlobPart[] = [];
    const done = new Promise<Blob>((resolve, reject) => {
      recording!.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recording!.onerror = () =>
        reject(
          new Error(
            "Your browser could not finish recording. Try a shorter film.",
          ),
        );
      recording!.onstop = () =>
        signal.aborted
          ? reject(new DOMException("Export cancelled", "AbortError"))
          : resolve(new Blob(chunks, { type: mimeType }));
    });
    const perScene = film.duration / film.scenes.length;
    let previous = -1;
    const draw = (elapsed: number) => {
      const index = Math.min(
        film.scenes.length - 1,
        Math.floor(elapsed / perScene),
      );
      const scene = film.scenes[index];
      const frame = frames[index];
      const fraction = (elapsed % perScene) / perScene;
      if (index !== previous) {
        frames[previous]?.video?.pause();
        if (frame.video) {
          frame.video.currentTime = 0;
          void frame.video.play().catch(() => {});
        }
        previous = index;
      }
      ctx.fillStyle = "#172e28";
      ctx.fillRect(0, 0, 1920, 1080);
      const visual = frame.video || frame.image;
      if (visual) {
        const w = frame.video ? frame.video.videoWidth : frame.image!.width;
        const h = frame.video ? frame.video.videoHeight : frame.image!.height;
        const scale =
          Math.min(1920 / w, 1080 / h) *
          (film.style === "Cinematic" ? 1 + fraction * 0.035 : 1);
        ctx.drawImage(
          visual,
          (1920 - w * scale) / 2,
          (1080 - h * scale) / 2,
          w * scale,
          h * scale,
        );
      } else {
        ctx.strokeStyle = "#496254";
        ctx.lineWidth = 2;
        for (let k = 0; k < 6; k++) {
          ctx.beginPath();
          ctx.arc(1530, 400, 140 + k * 70 + fraction * 15, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = "#f6f0e5";
        ctx.font = "400 70px Georgia";
        lines(ctx, film.title || "A family story", 1300)
          .slice(0, 3)
          .forEach((line, i) => ctx.fillText(line, 130, 330 + i * 85));
        ctx.font = "400 30px Arial";
        ctx.fillText(film.ancestor, 130, 610);
      }
      const gradient = ctx.createLinearGradient(0, 560, 0, 1080);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, "rgba(0,0,0,.88)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 560, 1920, 520);
      ctx.fillStyle = "#fff";
      ctx.font = "400 24px Arial";
      ctx.fillText(
        `${String(index + 1).padStart(2, "0")} / ${film.scenes.length}     ${scene.title}`,
        100,
        820,
      );
      ctx.font = "400 36px Arial";
      const captionLines = lines(ctx, scene.narration, 1690);
      const page = Math.min(
        Math.max(0, Math.ceil(captionLines.length / 3) - 1),
        Math.floor(fraction * Math.max(1, Math.ceil(captionLines.length / 3))),
      );
      captionLines
        .slice(page * 3, page * 3 + 3)
        .forEach((line, i) => ctx.fillText(line, 100, 887 + i * 46));
      ctx.font = "400 18px Arial";
      ctx.fillStyle = "#d9d9d9";
      ctx.fillText(frame.caption.slice(0, 130), 100, 1040);
      // Subtle fade at each cut.
      const fade = Math.min(
        1,
        index === 0 ? 1 : (fraction * perScene) / 0.3,
        ((1 - fraction) * perScene) / 0.3,
      );
      if (fade < 1) {
        ctx.fillStyle = `rgba(0,0,0,${1 - fade})`;
        ctx.fillRect(0, 0, 1920, 1080);
      }
    };
    draw(0.05);
    recording.start(1000);
    sound?.start();
    const start = performance.now();
    const stop = () => {
      if (recording?.state === "recording") recording.stop();
    };
    signal.addEventListener("abort", stop, { once: true });
    timer = setInterval(() => {
      const elapsed = (performance.now() - start) / 1000;
      draw(Math.min(elapsed, film.duration - 0.001));
      onProgress(
        Math.min(99, Math.round((elapsed / film.duration) * 100)),
        `Creating your film · ${Math.max(0, Math.ceil(film.duration - elapsed))} seconds remaining`,
      );
      if (elapsed >= film.duration) {
        clearInterval(timer);
        stop();
      }
    }, 1000 / 30);
    const blob = await done;
    signal.removeEventListener("abort", stop);
    if (blob.size < 1000)
      throw new Error("The film export was empty. Please try again.");
    onProgress(100, "Film created. Saving your master…");
    return blob;
  } finally {
    if (timer) clearInterval(timer);
    if (recording?.state === "recording") recording.stop();
    stream?.getTracks().forEach((track) => track.stop());
    for (const frame of new Set([...frames, ...mediaCache.values()])) {
      frame.image?.close();
      frame.video?.pause();
      if (frame.url) URL.revokeObjectURL(frame.url);
    }
    await audio.close();
    await wakeLock?.release().catch(() => {});
  }
}
