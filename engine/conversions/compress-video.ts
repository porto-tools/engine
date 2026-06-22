// Compress Video — reduce MP4 file size by re-encoding at a lower bitrate.
//
// The tool started with one "level" select (Smaller / Balanced / Better) mapping
// to a video bitrate. It now offers more control, all built around bitrate +
// resolution (the only size levers libopenh264 gives us — see the encoder note):
//
//   • Compression mode — how the target video bitrate is chosen:
//       "By level"        — the original three presets (Smaller/Balanced/Better)
//       "Custom bitrate"  — pick an explicit video bitrate yourself
//       "Target size (MB)" — name a file size; we work out the bitrate from the
//                            video's duration (so a 2-minute clip and a 20-second
//                            clip aiming for the same MB get very different rates)
//   • Output size — keep the original resolution or downscale to 1080p/720p/480p.
//     Downscaling is the single most effective size lever after bitrate.
//
// Level → video bitrate:
//   Smaller  — 800k  (lighter file, more visible compression)
//   Balanced — 1500k (a good everyday tradeoff)        ← default
//   Better   — 3000k (closer to original quality, moderately smaller)
//
// Encoder: libopenh264 (Cisco's open-source H.264, same as GIF→MP4 and WEBM→MP4).
// IMPORTANT: libopenh264 is BITRATE-based. It does NOT support -crf (a libx264/
// libx265 feature, and libx264 is not in this build). So every mode resolves to a
// concrete -b:v value; there is no quality/CRF knob.
// Audio: AAC at 128k — perceptually transparent for most content, small overhead.
//
// Engine: multi-threaded ffmpeg core. All video routes share the MT core and
// carry COOP + COEP headers (public/_headers) for SharedArrayBuffer/pthreads.
//
// MIME: accepts video/mp4; tolerates empty MIME when extension is .mp4, matching
// the pattern established by MP4→GIF and MP4→WEBM.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg, probeVideoDuration } from "./ffmpeg-core";

const IN_NAME = "input.mp4";
const OUT_NAME = "output.mp4";

// ── Levels (the original presets) ──────────────────────────────────────────────
type Level = "Smaller" | "Balanced" | "Better";

const LEVEL_VIDEO_BITRATE: Record<Level, string> = {
  Smaller:  "800k",
  Balanced: "1500k",
  Better:   "3000k",
};

const DEFAULT_LEVEL: Level = "Balanced";

// ── Compression mode ───────────────────────────────────────────────────────────
type Mode = "level" | "custom" | "size";
const DEFAULT_MODE: Mode = "level";

// ── Resolution downscale ───────────────────────────────────────────────────────
// "keep" emits no -vf at all (default → byte-identical to the original tool).
// Each other value maps to scale=-2:<height>, where -2 lets ffmpeg pick an even
// width that preserves the aspect ratio (even dimensions are required by H.264).
type Resolution = "keep" | "1080" | "720" | "480";
const DEFAULT_RESOLUTION: Resolution = "keep";

const RESOLUTION_OPTIONS = ["keep", "1080", "720", "480"] as const;

// ── Custom bitrate ─────────────────────────────────────────────────────────────
// Explicit video bitrates the user can pick in "Custom bitrate" mode. The default
// (1500k) matches the Balanced level so switching mode without touching the value
// is a no-op surprise-free.
const BITRATE_OPTIONS = [
  "400k", "600k", "800k", "1200k", "1500k", "2000k", "3000k", "5000k",
] as const;
type BitrateOption = (typeof BITRATE_OPTIONS)[number];
const DEFAULT_BITRATE: BitrateOption = "1500k";

// ── Target size (MB) ───────────────────────────────────────────────────────────
// Audio runs at 128k; subtract it from the budget so the *total* file lands near
// the target. Clamp the derived video bitrate to a sane floor/ceiling so a tiny
// target on a long clip can't ask for an unusable 12k stream (and a huge target
// can't blow past anything reasonable).
const AUDIO_BITRATE_BPS = 128_000;
const TARGET_MB_DEFAULT = 10;
const TARGET_MB_MIN = 1;
const TARGET_MB_MAX = 2000;
const VIDEO_BITRATE_FLOOR_BPS = 150_000; // ≥150k — below this H.264 falls apart
const VIDEO_BITRATE_CEIL_BPS = 50_000_000; // 50 Mbps ceiling — well past any need

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

// ── Defensive option readers ───────────────────────────────────────────────────

function resolveLevel(value: unknown): Level {
  if (value === "Smaller" || value === "Balanced" || value === "Better") return value;
  return DEFAULT_LEVEL;
}

function resolveMode(value: unknown): Mode {
  if (value === "level" || value === "custom" || value === "size") return value;
  return DEFAULT_MODE;
}

function resolveResolution(value: unknown): Resolution {
  return (RESOLUTION_OPTIONS as readonly string[]).includes(value as string)
    ? (value as Resolution)
    : DEFAULT_RESOLUTION;
}

function resolveBitrate(value: unknown): BitrateOption {
  return (BITRATE_OPTIONS as readonly string[]).includes(value as string)
    ? (value as BitrateOption)
    : DEFAULT_BITRATE;
}

function resolveTargetMb(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return TARGET_MB_DEFAULT;
  return Math.min(TARGET_MB_MAX, Math.max(TARGET_MB_MIN, n));
}

// Compute the video bitrate (as an ffmpeg arg string like "742k") for a target
// file size. budgetBits = targetMb × 8 × 1024 × 1024; reserve the audio budget,
// spread the rest across the clip's duration, then clamp. Falls back to the
// Balanced level when duration is unknown (0) so target-size never produces a
// nonsense stream — exported for direct testing.
export function targetSizeVideoBitrate(targetMb: number, durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return LEVEL_VIDEO_BITRATE.Balanced;
  }
  const budgetBits = targetMb * 8 * 1024 * 1024;
  const audioBits = AUDIO_BITRATE_BPS * durationSec;
  const videoBitsPerSec = (budgetBits - audioBits) / durationSec;
  const clamped = Math.min(
    VIDEO_BITRATE_CEIL_BPS,
    Math.max(VIDEO_BITRATE_FLOOR_BPS, Math.round(videoBitsPerSec)),
  );
  // Express in kbit so ffmpeg gets a tidy "<n>k" rather than a long bit count.
  return `${Math.max(1, Math.round(clamped / 1000))}k`;
}

export interface CompressOptions {
  mode?: unknown;
  level?: unknown;
  bitrate?: unknown;
  resolution?: unknown;
  targetMb?: unknown;
}

export interface CompressContext {
  // Source duration in seconds. Only consulted in "size" mode; omitted/0 elsewhere.
  duration?: number;
}

// Resolve the video bitrate arg string from the (validated) options + context.
// Exported so the bitrate policy can be unit-tested independently of arg order.
export function resolveVideoBitrate(opts: CompressOptions, ctx: CompressContext = {}): string {
  const mode = resolveMode(opts.mode);
  if (mode === "custom") return resolveBitrate(opts.bitrate);
  if (mode === "size") return targetSizeVideoBitrate(resolveTargetMb(opts.targetMb), ctx.duration ?? 0);
  // mode === "level" (default)
  return LEVEL_VIDEO_BITRATE[resolveLevel(opts.level)];
}

// Pure helper: builds the full ffmpeg args array from (validated) options +
// context. Mirrors mp4-gif.ts's buildGifFilter so tests assert against it cheaply.
//
// DEFAULTS — mode=level, level=Balanced, resolution=keep — reproduce the original
// tool's args BYTE-FOR-BYTE:
//   -i input.mp4 -c:v libopenh264 -b:v 1500k -c:a aac -b:a 128k output.mp4
// "keep" resolution emits no -vf; any downscale inserts -vf scale=-2:<height>
// right after -i (so the encoder sees the scaled frames).
export function buildCompressArgs(opts: CompressOptions = {}, ctx: CompressContext = {}): string[] {
  const videoBitrate = resolveVideoBitrate(opts, ctx);
  const resolution = resolveResolution(opts.resolution);

  const args: string[] = ["-i", IN_NAME];
  if (resolution !== "keep") {
    args.push("-vf", `scale=-2:${resolution}`);
  }
  args.push(
    "-c:v", "libopenh264",
    "-b:v", videoBitrate,
    "-c:a", "aac",
    "-b:a", "128k",
    OUT_NAME,
  );
  return args;
}

async function convertCompressVideo(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  const opts = (options ?? {}) as CompressOptions;

  // Only "Target size (MB)" mode needs the clip's duration. probeVideoDuration is
  // a hidden-<video> read that returns 0 in non-DOM/test envs and on any metadata
  // failure, so target-size degrades to the Balanced bitrate rather than throwing.
  let duration = 0;
  if (resolveMode(opts.mode) === "size") {
    duration = await probeVideoDuration(file);
    throwIfAborted(signal);
  }

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Compressing" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Compressing", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  const FFMPEG_ARGS = buildCompressArgs(opts, { duration });

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
      "We couldn't compress this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't compress this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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

export const compressVideoDescriptor: ConversionDescriptor = {
  id: "compress-video",
  fromLabel: "MP4",
  toLabel: "Compressed",
  accept: ["video/mp4"],
  newExtension: "mp4",
  // Many files at once, each with its own settings, converted independently.
  inputMode: "multi-compress",
  // Defaults reproduce the original one-click output exactly: mode "By level" +
  // Balanced (1500k), resolution "Keep original" (no -vf). The extra controls only
  // change the args when the user moves off these defaults.
  defaultOptions: {
    mode: DEFAULT_MODE,
    level: DEFAULT_LEVEL,
    bitrate: DEFAULT_BITRATE,
    resolution: DEFAULT_RESOLUTION,
    targetMb: TARGET_MB_DEFAULT,
  },
  controls: [
    {
      type: "select",
      id: "mode",
      label: "Compression mode",
      help: "Pick a preset level, set an exact rate, or aim for a target file size.",
      default: DEFAULT_MODE,
      options: [
        { value: "level",  label: "By level — simple presets" },
        { value: "custom", label: "Custom rate — pick it yourself" },
        { value: "size",   label: "Target size (MB) — aim for a file size" },
      ],
    },
    {
      type: "select",
      id: "level",
      label: "Compression level",
      help: "Smaller produces the tiniest file; Better keeps more visual detail at a larger size.",
      default: DEFAULT_LEVEL,
      options: [
        { value: "Smaller",  label: "Smaller — heavier compression" },
        { value: "Balanced", label: "Balanced — a good size/quality tradeoff" },
        { value: "Better",   label: "Better — closer to original quality" },
      ],
    },
    {
      type: "select",
      id: "bitrate",
      label: "Video rate",
      help: "A higher rate keeps more detail but makes a larger file. Used in Custom mode.",
      default: DEFAULT_BITRATE,
      options: [
        { value: "400k",  label: "400k — tiny, lowest quality" },
        { value: "600k",  label: "600k" },
        { value: "800k",  label: "800k" },
        { value: "1200k", label: "1200k" },
        { value: "1500k", label: "1500k — balanced default" },
        { value: "2000k", label: "2000k" },
        { value: "3000k", label: "3000k" },
        { value: "5000k", label: "5000k — largest, highest quality" },
      ],
    },
    {
      type: "number",
      id: "targetMb",
      label: "Target size",
      help: "Aim for roughly this file size in megabytes. Used in Target size mode.",
      default: TARGET_MB_DEFAULT,
      min: TARGET_MB_MIN,
      max: TARGET_MB_MAX,
      step: 1,
      unit: "MB",
    },
    {
      type: "select",
      id: "resolution",
      label: "Output size",
      help: "Keep the original size, or scale down — a smaller frame is a much smaller file.",
      default: DEFAULT_RESOLUTION,
      options: [
        { value: "keep", label: "Keep original" },
        { value: "1080", label: "1080p — Full HD" },
        { value: "720",  label: "720p — HD" },
        { value: "480",  label: "480p — small" },
      ],
    },
  ],
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  setupSizeLabel: "≈ 26 MB",
  convert: convertCompressVideo,
};
