// Video trim — cut a time range out of an MP4 without re-encoding.
//
// Uses ffmpeg's stream-copy mode (`-c copy`) so the operation is near-instant
// and lossless: the video and audio streams are copied byte-for-byte between
// the specified timestamps with no quality loss. The trade-off is that seeking
// snaps to the nearest keyframe; frame-accurate trimming would require a full
// re-encode but would be 10–100× slower in WASM.
//
// Controls: one visual "time-range" control (the trim timeline), which fans out
// to two numeric option keys in SECONDS — `trimStart` and `trimEnd`. We pass
// those to ffmpeg as `-ss <start>` / `-to <end>` after defensive clamping
// (trimEnd > trimStart >= 0).
//
// Engine: the multi-threaded core (decision 0009 §3). All video routes share
// the MT core and carry COOP + COEP headers (public/_headers).

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";

const IN_NAME = "input.mp4";
const OUT_NAME = "output.mp4";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

// Accept video/mp4 (standard) and tolerate empty MIME when the extension is
// .mp4, mirroring the tolerance established in the MP4→GIF route.
function isMp4File(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/mp4") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "mp4";
  }
  return false;
}

// Coerce a seconds option from the time-range control to a finite, non-negative
// number. The control emits plain numbers, but tolerate a numeric string too;
// anything else (undefined, NaN, negative) falls back to `fallback`.
function toSeconds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

async function convertVideoTrim(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  // Read the two seconds keys the time-range control emits. Defensive: clamp to
  // trimEnd > trimStart >= 0. trimEnd defaults to 0 ("unset"); a 0 (or end ≤
  // start) end means "copy through to the end of the file" — we omit -to.
  const trimStart = toSeconds(options?.trimStart, 0);
  const rawEnd = toSeconds(options?.trimEnd, 0);
  const hasEnd = rawEnd > trimStart;
  const trimEnd = hasEnd ? rawEnd : 0;

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Trimming" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Trimming", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // -ss <start>   — seek to start timestamp (before -i for fast keyframe seek)
  // -to <end>     — cut at end timestamp (absolute, not duration)
  // -i input.mp4  — input placed AFTER -ss for input seek
  // -c copy       — stream copy, no re-encode (fast, lossless, keyframe-snapped)
  //
  // When no usable end is specified (trimEnd ≤ trimStart) we omit -to and copy
  // through to the end of the file.
  const FFMPEG_ARGS: string[] = [];
  if (trimStart > 0) FFMPEG_ARGS.push("-ss", String(trimStart));
  if (hasEnd) FFMPEG_ARGS.push("-to", String(trimEnd));
  FFMPEG_ARGS.push("-i", IN_NAME, "-c", "copy", OUT_NAME);

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
      "We couldn't trim this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't trim this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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

export const videoTrimDescriptor: ConversionDescriptor = {
  id: "video-trim",
  fromLabel: "MP4",
  toLabel: "Trimmed MP4",
  accept: ["video/mp4"],
  newExtension: "mp4",
  // trimStart/trimEnd are SECONDS. trimEnd 0 = "unset" (copy through to the end);
  // the time-range control seeds the real range (0 → full duration) once the
  // video's duration loads.
  defaultOptions: { trimStart: 0, trimEnd: 0 },
  controls: [
    {
      type: "time-range",
      id: "trim",
      label: "Trim range",
      help: "Drag the green handles on the timeline to set where the clip starts and ends. The grey shows what gets trimmed away. Cuts snap to the nearest keyframe, so the start may shift by a fraction of a second.",
    },
  ],
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  setupSizeLabel: "≈ 26 MB",
  convert: convertVideoTrim,
};
