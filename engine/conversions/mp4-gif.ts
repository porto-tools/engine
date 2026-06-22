// MP4 → GIF. The first video conversion route, validating the multi-threaded
// ffmpeg core before the other three video routes are replicated.
//
// GIF is a palette-indexed format capped at 256 colours per frame. A quality
// GIF requires a one-pass palette filtergraph: `palettegen` analyses the full
// video to build an optimal palette, then `paletteuse` applies it. We cap width
// at 480 px (height auto, preserving aspect ratio) at 12 fps so the output is
// useful for sharing without growing enormous. Larger originals can be dropped
// with the expectation that the user will get a reasonably sized GIF back.
//
// Engine: the multi-threaded core (decision 0009 §3). Video transcodes benefit
// significantly from multi-threading; MT is ~2.1× faster on video. The four
// video pages carry COOP + COEP headers (public/_headers) so SharedArrayBuffer
// is available. Audio routes stay on the ST core to keep AdSense alive.
//
// MIME note: browsers report dropped .mp4 files as "video/mp4", but some OS
// file pickers report "" or an alias. We accept the standard type and tolerate
// empty MIME when the extension is .mp4 — matching the pattern established by
// the MP3 route.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";

const IN_NAME = "input.mp4";
const OUT_NAME = "output.gif";

// ── Quality controls ──────────────────────────────────────────────────────────
//
// MP4→GIF used to ship a single fixed filtergraph. It now reads four options and
// rebuilds that filter from them. The DEFAULTS reproduce the original filter,
// extended only with palettegen's max_colors (formerly unbounded → now 128) and
// paletteuse's dither (formerly the ffmpeg default → now bayer, the same dither
// ffmpeg already applied by default, made explicit). Pass no options and the
// behaviour is unchanged.

const DEFAULT_FPS = 12;
const FPS_MIN = 5;
const FPS_MAX = 30;

const DEFAULT_WIDTH = "480";
const WIDTH_OPTIONS = ["480", "320", "240", "640"] as const;
type WidthOption = (typeof WIDTH_OPTIONS)[number];

const DEFAULT_COLORS = 128;
const COLORS_MIN = 32;
const COLORS_MAX = 256;

const DEFAULT_DITHER = "bayer";
const DITHER_OPTIONS = ["bayer", "sierra2_4a", "none"] as const;
type DitherOption = (typeof DITHER_OPTIONS)[number];

// A26: explicit output height. "auto" keeps the existing width-driven scale
// (scale=<width>:-1) so the default output is byte-identical to before. An
// explicit height switches the sizing mode to scale=-2:<height> (width auto,
// rounded to an even number for the encoder), and the width option is ignored.
const DEFAULT_HEIGHT = "auto";
const HEIGHT_OPTIONS = ["auto", "240", "360", "480", "720"] as const;
type HeightOption = (typeof HEIGHT_OPTIONS)[number];

// A26: GIF loop count. ffmpeg's GIF muxer default is -loop 0 = loop forever, so
// "0" is both the UI default and a true no-op. 1 = play once (no loop), 3/5 =
// repeat that many extra times.
const DEFAULT_LOOP = "0";
const LOOP_OPTIONS = ["0", "1", "3", "5"] as const;
type LoopOption = (typeof LOOP_OPTIONS)[number];

export interface GifFilterOptions {
  fps?: unknown;
  width?: unknown;
  colors?: unknown;
  dither?: unknown;
  height?: unknown;
}

// Defensive number reader: coerce, reject non-finite, round, then clamp to range.
function readClampedInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readWidth(value: unknown): WidthOption {
  return (WIDTH_OPTIONS as readonly string[]).includes(value as string)
    ? (value as WidthOption)
    : DEFAULT_WIDTH;
}

function readDither(value: unknown): DitherOption {
  return (DITHER_OPTIONS as readonly string[]).includes(value as string)
    ? (value as DitherOption)
    : DEFAULT_DITHER;
}

function readHeight(value: unknown): HeightOption {
  return (HEIGHT_OPTIONS as readonly string[]).includes(value as string)
    ? (value as HeightOption)
    : DEFAULT_HEIGHT;
}

function readLoop(value: unknown): LoopOption {
  return (LOOP_OPTIONS as readonly string[]).includes(value as string)
    ? (value as LoopOption)
    : DEFAULT_LOOP;
}

// Coerce a seconds option from the time-range control to a finite, non-negative
// number. The control emits plain numbers, but tolerate a numeric string too;
// anything else (undefined, NaN, negative) falls back to `fallback`. Copied from
// video-trim.ts — the same time-range control feeds both routes.
function toSeconds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// Pure helper: builds the libavfilter graph string from (validated) options.
// Mirrors the one-pass palette filtergraph documented above the ffmpeg call.
// Defaults reproduce the original fixed filter plus max_colors=128 / dither=bayer.
//
// Sizing: when `height` is "auto" (default) the graph uses the original
// width-driven scale=<width>:-1 (height follows the aspect ratio), so the
// default output is byte-identical. An explicit height flips to scale=-2:<height>
// (width follows, rounded to an even number) and the width option is ignored.
// Trim and loop are NOT filtergraph options — they are input/output args handled
// in convertMp4ToGif — so this helper stays pure to (fps, width, colors, dither,
// height) only.
export function buildGifFilter(opts: GifFilterOptions = {}): string {
  const fps = readClampedInt(opts.fps, FPS_MIN, FPS_MAX, DEFAULT_FPS);
  const width = readWidth(opts.width);
  const colors = readClampedInt(opts.colors, COLORS_MIN, COLORS_MAX, DEFAULT_COLORS);
  const dither = readDither(opts.dither);
  const height = readHeight(opts.height);
  const scale = height === "auto" ? `scale=${width}:-1` : `scale=-2:${height}`;
  return (
    `fps=${fps},${scale}:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=max_colors=${colors}[p];[s1][p]paletteuse=dither=${dither}`
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

// Accept video/mp4 (standard) and tolerate empty MIME when the extension is
// .mp4, mirroring the tolerance in the MP3 route.
function isMp4File(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/mp4") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "mp4";
  }
  return false;
}

async function convertMp4ToGif(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  // A26 trim: the time-range control fans out to trimStart/trimEnd in SECONDS
  // (same as video-trim.ts). Defensive: clamp to trimEnd > trimStart >= 0. A 0
  // (or end ≤ start) end means "convert through to the end" — we omit -to.
  const trimStart = toSeconds(options?.trimStart, 0);
  const rawEnd = toSeconds(options?.trimEnd, 0);
  const hasEnd = rawEnd > trimStart;
  const trimEnd = hasEnd ? rawEnd : 0;

  // A26 loop: GIF loop count, read defensively (invalid → "0" = infinite, the
  // ffmpeg GIF muxer default, so the no-op default is byte-identical).
  const loop = readLoop(options?.loop);

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Converting" });

  // ffmpeg's progress event reports a 0..1 ratio. For a transcode the ratio
  // is reliable once ffmpeg has determined output duration from the input.
  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Converting", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // Quality GIF via a one-pass palette filtergraph, parameterised by the four
  // quality controls (buildGifFilter clamps/validates each option, falling back
  // to defaults that reproduce the original fixed filter):
  //   fps=<fps>           — cap frame rate (default 12; GIF sweet-spot)
  //   scale=<width>:-1    — resize to <width> px wide, preserve aspect ratio
  //   flags=lanczos       — high-quality downscale filter
  //   split[s0][s1]       — fork the scaled stream into two branches
  //   [s0]palettegen=max_colors=<colors>[p] — build an optimal palette (≤ colors)
  //   [s1][p]paletteuse=dither=<dither>     — apply the palette to each frame
  //
  // This avoids the washed-out colours of a default GIF encode. The split is
  // handled entirely inside the libavfilter graph; no intermediate files.
  const vf = buildGifFilter(options as GifFilterOptions | undefined);

  // Argument order matters:
  //   -ss <start> / -to <end>  — INPUT seek, placed BEFORE -i so ffmpeg seeks at
  //                              the demuxer (fast, and the filtergraph then sees
  //                              only the trimmed range). Omitted when unset
  //                              (start 0 / no usable end) so defaults are
  //                              byte-identical to the pre-A26 command.
  //   -i input.mp4             — input, after the seek args.
  //   -vf <filtergraph>        — the palette filtergraph (buildGifFilter).
  //   -loop <n>                — OUTPUT arg for the GIF muxer (0 = infinite, the
  //                              default; 1 = play once; 3/5 = repeat n times).
  const FFMPEG_ARGS: string[] = [];
  if (trimStart > 0) FFMPEG_ARGS.push("-ss", String(trimStart));
  if (hasEnd) FFMPEG_ARGS.push("-to", String(trimEnd));
  FFMPEG_ARGS.push("-i", IN_NAME, "-vf", vf, "-loop", loop, OUT_NAME);

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
      "We couldn't convert this file. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't convert this file. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: "image/gif" });

  return {
    blob,
    filename: replaceExtension(file.name, "gif"),
    mimeType: "image/gif",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const mp4GifDescriptor: ConversionDescriptor = {
  id: "mp4-to-gif",
  fromLabel: "MP4",
  toLabel: "GIF",
  accept: ["video/mp4"],
  newExtension: "gif",
  // Quality controls. Defaults reproduce the original one-click filter (plus the
  // now-explicit max_colors=128 / dither=bayer), so the out-of-the-box result is
  // unchanged — the user can now trade size for fidelity before converting.
  defaultOptions: {
    fps: DEFAULT_FPS,
    width: DEFAULT_WIDTH,
    colors: DEFAULT_COLORS,
    dither: DEFAULT_DITHER,
    // A26 additions. All no-ops out of the box so the default output is
    // unchanged: trim 0/0 = whole clip, loop "0" = infinite (the GIF default),
    // height "auto" = the existing width-driven scale.
    trimStart: 0,
    trimEnd: 0,
    loop: DEFAULT_LOOP,
    height: DEFAULT_HEIGHT,
  },
  controls: [
    {
      type: "range",
      id: "fps",
      label: "Frame rate",
      help: "Higher fps is smoother but larger; lower fps is choppier but smaller.",
      default: DEFAULT_FPS,
      min: FPS_MIN,
      max: FPS_MAX,
      step: 1,
      unit: "fps",
    },
    {
      type: "select",
      id: "width",
      label: "Width",
      help: "Output width in pixels; height scales to preserve the aspect ratio.",
      default: DEFAULT_WIDTH,
      options: [
        { value: "240", label: "240 px — smallest" },
        { value: "320", label: "320 px" },
        { value: "480", label: "480 px — default" },
        { value: "640", label: "640 px — largest" },
      ],
    },
    {
      type: "range",
      id: "colors",
      label: "Colours",
      help: "Maximum palette colours. Fewer colours shrink the file; more keep fidelity.",
      default: DEFAULT_COLORS,
      min: COLORS_MIN,
      max: COLORS_MAX,
      step: 32,
      unit: "colours",
    },
    {
      type: "select",
      id: "dither",
      label: "Dithering",
      help: "Bayer is crisp and small; sierra2_4a smooths gradients; none is flattest.",
      default: DEFAULT_DITHER,
      options: [
        { value: "bayer", label: "Bayer — crisp, small (default)" },
        { value: "sierra2_4a", label: "Sierra2 4a — smooth gradients" },
        { value: "none", label: "None — no dithering" },
      ],
    },
    // A26: explicit output height. "auto" keeps the width-driven scale (default,
    // byte-identical). Choosing a height switches to a height-driven scale and
    // the Width control above is ignored.
    {
      type: "select",
      id: "height",
      label: "Height",
      help: "Output height in pixels. Auto lets the Width setting drive the size; pick a height to size by height instead (width then scales to preserve the aspect ratio).",
      default: DEFAULT_HEIGHT,
      options: [
        { value: "auto", label: "Auto — use Width (default)" },
        { value: "240", label: "240 px — smallest" },
        { value: "360", label: "360 px" },
        { value: "480", label: "480 px" },
        { value: "720", label: "720 px — largest" },
      ],
    },
    // A26: how many times the GIF loops. 0 (infinite) is the ffmpeg GIF default.
    {
      type: "select",
      id: "loop",
      label: "Loop",
      help: "How many times the GIF replays. Infinite loops forever; Play once stops on the last frame.",
      default: DEFAULT_LOOP,
      options: [
        { value: "0", label: "Infinite — loop forever (default)" },
        { value: "1", label: "Play once" },
        { value: "3", label: "Repeat 3 times" },
        { value: "5", label: "Repeat 5 times" },
      ],
    },
    // A26: trim timeline. Shares the time-range control with video-trim.ts; fans
    // out to trimStart/trimEnd in seconds, applied as input-seek args (-ss/-to).
    {
      type: "time-range",
      id: "trim",
      label: "Trim range",
      help: "Drag the green handles on the timeline to pick the part of the clip to turn into a GIF. Everything in grey is left out. Trimming a long clip is the most effective way to keep the GIF small.",
    },
  ],
  // Loads the multi-threaded ffmpeg core (decision 0009). The MT core requires
  // cross-origin isolation (COOP + COEP headers, public/_headers).
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  // The MT core (ffmpeg-core.js + .wasm + .worker.js) is the one-time download
  // shown in the setup state while loadEngine runs.
  setupSizeLabel: "≈ 26 MB",
  convert: convertMp4ToGif,
};
