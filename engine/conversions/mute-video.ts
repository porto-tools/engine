// Mute video — strips the audio track from an MP4, keeping the video stream
// untouched (stream-copy, no re-encode).
//
// FFmpeg command: `ffmpeg -i input.mp4 -c:v copy -an output.mp4`
//   -c:v copy  stream-copy the video (fast, lossless, no re-encode)
//   -an        discard all audio streams
//
// No controls: the operation is deterministic and has no meaningful parameters.
//
// Engine: the multi-threaded core. The video data is stream-copied (no decode),
// but we still use MT so we stay consistent with the other video tools and
// preserve the ability to add transcoding options later.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";

const IN_NAME  = "input.mp4";
const OUT_NAME = "output.mp4";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

function isMp4File(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/mp4") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "mp4";
  }
  return false;
}

async function convertMuteVideo(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Muting" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Muting", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // Stream-copy the video track (-c:v copy) and drop all audio (-an).
  // The stream-copy path is very fast — no decode/encode round-trip.
  const FFMPEG_ARGS = ["-i", IN_NAME, "-c:v", "copy", "-an", OUT_NAME];

  let result: { data: Uint8Array; exitCode: number };
  try {
    result = await runFFmpeg(ffmpeg, {
      inName: IN_NAME,
      outName: OUT_NAME,
      input: inputBytes,
      args: FFMPEG_ARGS,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new ConversionError("Conversion cancelled.", {
        code: "CANCELLED",
        recoverable: true,
      });
    }
    throw new ConversionError(
      "We couldn't mute this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: err instanceof Error ? err.message : String(err),
      },
    );
  } finally {
    if (onProgress) ffmpeg.off("progress", onFfmpegProgress);
  }

  throwIfAborted(signal);

  if (result.exitCode !== 0 || result.data.byteLength === 0) {
    throw new ConversionError(
      "We couldn't mute this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: "video/mp4" });

  return {
    blob,
    filename: replaceExtension(file.name, "mp4"),
    mimeType: "video/mp4",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const muteVideoDescriptor: ConversionDescriptor = {
  id: "mute-video",
  fromLabel: "MP4",
  toLabel: "Muted MP4",
  accept: ["video/mp4"],
  newExtension: "mp4",
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  // The MT core (ffmpeg-core.js + .wasm + .worker.js) is the one-time download
  // shown in the setup state while loadEngine runs.
  setupSizeLabel: "≈ 26 MB",
  convert: convertMuteVideo,
};
