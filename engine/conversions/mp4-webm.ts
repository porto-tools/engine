// MP4 → WEBM. Re-encodes an MP4 to a VP8/VP9 + Opus/Vorbis WEBM — the open,
// royalty-free web video format supported natively by all modern browsers.
//
// Codec choices:
//   Video: libvpx (VP8) is the DEFAULT — VP8 is royalty-free, supported by every
//                        modern browser, and far faster than VP9 in WASM (VP9
//                        encoding is 3–5× slower for a modest size win, and on the
//                        single-threaded dev core a long clip can take 20+ minutes).
//                        VP9 (libvpx-vp9) is offered as an OPTIONAL codec for users
//                        who want better compression and can wait — but VP9 in the
//                        WASM build is NOT yet confirmed (see the happy-path test's
//                        in-browser verification note), so VP8 stays the default.
//   Audio: libopus (default) — the recommended audio codec for WebM, better quality
//                        per bit than Vorbis at all bitrates. libvorbis is offered
//                        as an alternative for players that lack Opus support.
//
// Performance note: even with VP8, the -deadline realtime + -cpu-used 8 flags are
// what keep encode time bounded in WASM — realtime skips multi-pass analysis and a
// high cpu-used selects the fastest mode. -b:v is pinned to the source's own bitrate
// budget (see recommendedVideoBitrate) rather than a flat 1 Mbps, which badly
// under-shot HD sources. -threads 0 lets the MT core spread work across pthreads; on
// the single-threaded dev core it harmlessly runs on one thread.
//
// VP9 is rate-controlled differently: `-b:v 0 -crf <n>` selects constant-quality
// mode (the recommended VP9 mode), so the source-matched bitrate is NOT used for VP9
// — the CRF knob governs quality there instead.
//
// Large files: in-browser ffmpeg runs inside a FIXED-size wasm heap (the MT core's
// shared memory has maximum === initial — it cannot grow). Very long or high-
// resolution videos can therefore exhaust memory and abort regardless of encoder
// speed. That is a core-memory limit, not a logic bug; the failure surfaces a clear
// "too large" message. The durable fix is rebuilding the ffmpeg core with a larger /
// growable heap (a CI task on the ffmpeg fork).
//
// Engine: the multi-threaded core (decision 0009 §3). All video routes share the
// MT core and carry COOP + COEP headers (public/_headers) for SharedArrayBuffer.
//
// MIME note: browsers report dropped .mp4 files as "video/mp4", but some OS file
// pickers report "" or an alias. We accept the standard type and tolerate empty
// MIME when the extension is .mp4 — matching the pattern established in MP4→GIF.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
  ControlSchema,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg, probeVideoDuration, recommendedVideoBitrate } from "./ffmpeg-core";
import {
  readEnum,
  readClampedInt,
  volumeFactor,
  SAMPLE_RATE_OPTIONS,
  BITRATE_OPTIONS,
  VOLUME_MIN,
  VOLUME_MAX,
  VOLUME_DEFAULT,
  sampleRateControl,
  bitrateControl,
  volumeControl,
  fadeControls,
  type AudioSettingsOptions,
} from "./audio-settings";

const IN_NAME = "input.mp4";
const OUT_NAME = "output.webm";

// ── Video codec ──────────────────────────────────────────────────────────────
// VP8 is the byte-identical default (the original one-click behaviour). VP9 is an
// optional, more-efficient codec gated behind an explicit choice.
const VIDEO_CODEC_OPTIONS = ["vp8", "vp9"] as const;
type VideoCodec = (typeof VIDEO_CODEC_OPTIONS)[number];
const DEFAULT_VIDEO_CODEC: VideoCodec = "vp8";

// ── CRF (VP9 only) ─────────────────────────────────────────────────────────────
// libvpx-vp9 constant-quality knob (10..63, lower = better quality). Ignored for
// VP8, which is bitrate-only.
const CRF_MIN = 10;
const CRF_MAX = 63;
const CRF_DEFAULT = 33;

// ── Preset → -deadline / -cpu-used ──────────────────────────────────────────────
// realtime = the original VP8 default (deadline realtime, cpu-used 8). good/best
// trade speed for quality. The cpu-used value differs per preset.
const PRESET_OPTIONS = ["realtime", "good", "best"] as const;
type Preset = (typeof PRESET_OPTIONS)[number];
const DEFAULT_PRESET: Preset = "realtime";

const PRESET_DEADLINE: Record<Preset, string> = {
  realtime: "realtime",
  good: "good",
  best: "best",
};
const PRESET_CPU_USED: Record<Preset, string> = {
  realtime: "8",
  good: "5",
  best: "0",
};

// ── Audio codec ──────────────────────────────────────────────────────────────
// libopus is the byte-identical default; libvorbis is the alternative.
const AUDIO_CODEC_OPTIONS = ["libopus", "libvorbis"] as const;
type AudioCodec = (typeof AUDIO_CODEC_OPTIONS)[number];
const DEFAULT_AUDIO_CODEC: AudioCodec = "libopus";

// ── Rotate ───────────────────────────────────────────────────────────────────
// "none" emits no -vf (the byte-identical default). Each rotation maps to ffmpeg
// transpose/flip filters: 90° = transpose=1, 180° = hflip,vflip, 270° = transpose=2.
const ROTATE_OPTIONS = ["none", "90", "180", "270"] as const;
type Rotate = (typeof ROTATE_OPTIONS)[number];
const DEFAULT_ROTATE: Rotate = "none";

const ROTATE_FILTER: Record<Exclude<Rotate, "none">, string> = {
  "90": "transpose=1",
  "180": "hflip,vflip",
  "270": "transpose=2",
};

// Fade bounds mirror audio-settings' fadeControls() (0..60s, 0 = no fade).
const FADE_MIN = 0;
const FADE_MAX = 60;
const FADE_DEFAULT = 0;

// ── Option shape ───────────────────────────────────────────────────────────────
// All fields are `unknown` because they arrive from the UI's untyped control bag
// and are validated by the readers below.
export interface Mp4WebmOptions extends AudioSettingsOptions {
  videoCodec?: unknown;
  crf?: unknown;
  preset?: unknown;
  audioCodec?: unknown;
  rotate?: unknown;
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
// .mp4, mirroring the tolerance in the MP4→GIF route.
function isMp4File(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/mp4") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "mp4";
  }
  return false;
}

// Build the audio filter chain (volume + fades) the same way buildAudioArgs does:
// volume (if ≠ 100) → fade-in → fade-out (reverse trick). Returned WITHOUT the
// -af flag so the caller can decide whether to emit it. Empty array ⇒ no filter.
function buildAudioFilters(options: Mp4WebmOptions): string[] {
  const volume = readClampedInt(options.volume, VOLUME_MIN, VOLUME_MAX, VOLUME_DEFAULT);
  const fadeIn = readClampedInt(options.fadeIn, FADE_MIN, FADE_MAX, FADE_DEFAULT);
  const fadeOut = readClampedInt(options.fadeOut, FADE_MIN, FADE_MAX, FADE_DEFAULT);

  const filters: string[] = [];
  if (volume !== VOLUME_DEFAULT) filters.push(`volume=${volumeFactor(volume)}`);
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) {
    // Reverse trick: fade the tail out without knowing the clip duration — reverse,
    // fade IN from t=0 over the tail, reverse back. Matches audio-settings.ts.
    filters.push("areverse", `afade=t=in:st=0:d=${fadeOut}`, "areverse");
  }
  return filters;
}

/**
 * Pure: assemble the full ffmpeg arg array for MP4→WEBM from (validated) options
 * and the source-matched video bitrate (used for VP8; VP9 ignores it in favour of
 * -crf). Mirrors compress-video.ts's buildCompressArgs so tests can assert cheaply.
 *
 * DEFAULTS — videoCodec vp8, preset realtime, audioCodec libopus, rotate none,
 * volume 100, no fades — reproduce the original one-click args BYTE-FOR-BYTE:
 *   -i input.mp4 -c:v libvpx -b:v <n> -deadline realtime -cpu-used 8 -threads 0
 *     -c:a libopus output.webm
 *
 * Arg order: -i  [-vf <rotate>]  <video codec block>  [-af <audio chain>]
 *            -c:a <audio codec>  [-b:a <bitrate>]  [-ar <hz>]  <out>
 * Rotate (-vf) and audio filters (-af) are SEPARATE flags so an even-dimension
 * guard on the rotate filter never collides with the audio chain.
 */
export function buildMp4ToWebmArgs(options: Mp4WebmOptions = {}, targetBitrate: number): string[] {
  const videoCodec = readEnum(options.videoCodec, VIDEO_CODEC_OPTIONS, DEFAULT_VIDEO_CODEC);
  const crf = readClampedInt(options.crf, CRF_MIN, CRF_MAX, CRF_DEFAULT);
  const preset = readEnum(options.preset, PRESET_OPTIONS, DEFAULT_PRESET);
  const audioCodec = readEnum(options.audioCodec, AUDIO_CODEC_OPTIONS, DEFAULT_AUDIO_CODEC);
  const bitrate = readEnum(options.bitrate, BITRATE_OPTIONS, "auto");
  const sampleRate = readEnum(options.sampleRate, SAMPLE_RATE_OPTIONS, "auto");
  const rotate = readEnum(options.rotate, ROTATE_OPTIONS, DEFAULT_ROTATE);

  const args: string[] = ["-i", IN_NAME];

  // Rotate as -vf, immediately after -i so the encoder sees rotated frames. WebM
  // output (VP8/VP9) has no yuv420p even-dimension constraint, so no toEven guard.
  if (rotate !== "none") {
    args.push("-vf", ROTATE_FILTER[rotate]);
  }

  // Video codec block.
  if (videoCodec === "vp9") {
    // VP9 constant-quality mode: -b:v 0 + -crf <n> is the recommended VP9 rate
    // control; the source bitrate is intentionally NOT used here.
    args.push(
      "-c:v", "libvpx-vp9",
      "-b:v", "0",
      "-crf", String(crf),
      "-deadline", PRESET_DEADLINE[preset],
      "-cpu-used", PRESET_CPU_USED[preset],
      "-threads", "0",
    );
  } else {
    // VP8: bitrate-only (no CRF). Pinned to the source's budget.
    args.push(
      "-c:v", "libvpx",
      "-b:v", String(targetBitrate),
      "-deadline", PRESET_DEADLINE[preset],
      "-cpu-used", PRESET_CPU_USED[preset],
      "-threads", "0",
    );
  }

  // Audio filters (volume/fade) as -af, separate from the rotate -vf.
  const audioFilters = buildAudioFilters(options);
  if (audioFilters.length > 0) {
    args.push("-af", audioFilters.join(","));
  }

  // Audio codec + optional bitrate / sample rate.
  args.push("-c:a", audioCodec);
  if (bitrate !== "auto") args.push("-b:a", bitrate);
  if (sampleRate !== "auto") args.push("-ar", sampleRate);

  args.push(OUT_NAME);
  return args;
}

async function convertMp4ToWebm(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  const opts = (options ?? {}) as Mp4WebmOptions;

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Converting" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Converting", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // A flat 1 Mbps target badly under-shoots HD sources (a 720p clip looked like
  // 180p). Pin the VP8 bitrate to the source's own budget instead. The realtime
  // preset keeps encode time bounded regardless of the target. (VP9 ignores this
  // and uses -crf constant-quality mode.)
  const targetBitrate = recommendedVideoBitrate(file.size, await probeVideoDuration(file));

  const FFMPEG_ARGS = buildMp4ToWebmArgs(opts, targetBitrate);

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
      "We couldn't convert this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't convert this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: "video/webm" });

  return {
    blob,
    filename: replaceExtension(file.name, "webm"),
    mimeType: "video/webm",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// Optional converter controls. DEFAULTS keep the args byte-identical to the
// original one-click VP8/Opus encode (see buildMp4ToWebmArgs).
const controls: ControlSchema[] = [
  {
    type: "select",
    id: "videoCodec",
    label: "Video codec",
    help: "VP8 is fast and works everywhere. VP9 compresses better but is much slower to encode in the browser.",
    default: DEFAULT_VIDEO_CODEC,
    options: [
      { value: "vp8", label: "VP8 — fast, broad support" },
      { value: "vp9", label: "VP9 — smaller file, slower encode" },
    ],
  },
  {
    type: "range",
    id: "crf",
    label: "Quality (VP9 only)",
    help: "Lower keeps more detail at a larger size. Only applies when the codec is VP9; VP8 ignores it.",
    default: CRF_DEFAULT,
    min: CRF_MIN,
    max: CRF_MAX,
    step: 1,
  },
  {
    type: "select",
    id: "preset",
    label: "Encode speed",
    help: "Realtime is fastest. Good and Best spend more time for better quality.",
    default: DEFAULT_PRESET,
    options: [
      { value: "realtime", label: "Realtime — fastest" },
      { value: "good", label: "Good — balanced" },
      { value: "best", label: "Best — slowest, highest quality" },
    ],
  },
  {
    type: "select",
    id: "rotate",
    label: "Rotate",
    help: "Turn the video by a quarter, half, or three-quarter turn.",
    default: DEFAULT_ROTATE,
    options: [
      { value: "none", label: "None" },
      { value: "90", label: "90° clockwise" },
      { value: "180", label: "180°" },
      { value: "270", label: "270° clockwise" },
    ],
  },
  {
    type: "select",
    id: "audioCodec",
    label: "Audio codec",
    help: "Opus is the recommended WebM audio codec. Vorbis is an older alternative for players without Opus support.",
    default: DEFAULT_AUDIO_CODEC,
    options: [
      { value: "libopus", label: "Opus — recommended" },
      { value: "libvorbis", label: "Vorbis — wider legacy support" },
    ],
  },
  sampleRateControl(),
  bitrateControl("auto"),
  volumeControl(),
  ...fadeControls(),
];

export const mp4WebmDescriptor: ConversionDescriptor = {
  id: "mp4-to-webm",
  fromLabel: "MP4",
  toLabel: "WEBM",
  accept: ["video/mp4"],
  newExtension: "webm",
  // Defaults reproduce the original one-click output exactly: VP8 + Opus, realtime
  // preset, no rotate, 100% volume, no fades, encoder-default audio bitrate / rate.
  // The extra controls only change the args when the user moves off these defaults.
  defaultOptions: {
    videoCodec: DEFAULT_VIDEO_CODEC,
    crf: CRF_DEFAULT,
    preset: DEFAULT_PRESET,
    rotate: DEFAULT_ROTATE,
    audioCodec: DEFAULT_AUDIO_CODEC,
    sampleRate: "auto",
    bitrate: "auto",
    volume: VOLUME_DEFAULT,
    fadeIn: FADE_DEFAULT,
    fadeOut: FADE_DEFAULT,
  },
  controls,
  // Loads the multi-threaded ffmpeg core (decision 0009). The MT core requires
  // cross-origin isolation (COOP + COEP headers, public/_headers).
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  // The MT core (ffmpeg-core.js + .wasm + .worker.js) is the one-time download
  // shown in the setup state while loadEngine runs.
  setupSizeLabel: "≈ 26 MB",
  convert: convertMp4ToWebm,
};
