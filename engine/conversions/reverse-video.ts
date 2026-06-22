// Reverse video — plays an MP4 backwards (video reversed, audio reversed).
//
// FFmpeg command: `ffmpeg -i input.mp4 -vf reverse -af areverse output.mp4`
//   -vf reverse   reverses the video stream frame-by-frame
//   -af areverse  reverses the audio stream sample-by-sample
//
// MEMORY NOTE: `reverse` buffers the entire input into RAM before producing any
// output. For long or high-resolution videos this can exhaust available memory.
// This tool is best suited for short clips (ideally under 30 seconds). The About
// section on the page makes this explicit.
//
// No controls: the reversal operation is fully deterministic.
//
// Engine: the multi-threaded core (consistent with other video tools; MT is
// ~2× faster for the decode/encode round-trip that reverse requires).

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg, probeVideoDuration, recommendedVideoBitrate } from "./ffmpeg-core";

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

async function convertReverseVideo(input: ConversionInput): Promise<ConversionResult> {
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

  onProgress?.({ stage: "Reversing" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Reversing", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // Re-encoding through `reverse` would otherwise fall back to openh264's low
  // default bitrate and badly downgrade the video; pin it to the source's budget.
  const targetBitrate = recommendedVideoBitrate(file.size, await probeVideoDuration(file));

  // `reverse` buffers the whole decoded video in MEMFS before emitting frames
  // in reverse order; `areverse` does the same for audio samples.
  const FFMPEG_ARGS = [
    "-i", IN_NAME,
    "-vf", "reverse",
    "-af", "areverse",
    "-b:v", String(targetBitrate),
    "-b:a", "192k",
    OUT_NAME,
  ];

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
      "We couldn't reverse this video — the file may be damaged, not a valid MP4, or too long for the available memory.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      },
    );
  } finally {
    if (onProgress) ffmpeg.off("progress", onFfmpegProgress);
  }

  throwIfAborted(signal);

  if (result.exitCode !== 0 || result.data.byteLength === 0) {
    throw new ConversionError(
      "We couldn't reverse this video — the file may be damaged, not a valid MP4, or too long for the available memory.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
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

export const reverseVideoDescriptor: ConversionDescriptor = {
  id: "reverse-video",
  fromLabel: "MP4",
  toLabel: "Reversed MP4",
  accept: ["video/mp4"],
  newExtension: "mp4",
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  // The MT core (ffmpeg-core.js + .wasm + .worker.js) is the one-time download
  // shown in the setup state while loadEngine runs.
  setupSizeLabel: "≈ 26 MB",
  convert: convertReverseVideo,
};
