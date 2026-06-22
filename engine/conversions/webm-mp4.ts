// WEBM → MP4. Converts a VP8/VP9 WEBM to a broad-compatibility H.264/AAC MP4.
//
// WEBM is an open container (VP8/VP9 video + Vorbis/Opus audio) with excellent
// browser support but limited compatibility on older hardware players, iOS before
// 16, and many social platforms that require H.264/MP4. Converting to MP4 makes
// the file playable anywhere.
//
// Encoder choices:
//   Video: libopenh264  — Cisco's open-source H.264 encoder. Second use in the
//                         codebase (also used by GIF→MP4). yuv420p is required
//                         for QuickTime/iOS/Safari; +faststart moves the moov atom
//                         to the front so the browser can stream before EOF.
//                         libopenh264 is BITRATE-based — no CRF, no -preset, and no
//                         codec choice — so this route exposes NO video codec / crf /
//                         preset controls (unlike MP4→WEBM).
//   Audio: aac          — FFmpeg's native AAC encoder. Universally supported in
//                         MP4 containers. AAC-only here (no audio-codec choice), but
//                         the bitrate / sample rate / volume / fade knobs apply.
//
// Note: if the input WEBM has no audio track, ffmpeg will skip the -c:a aac step
// gracefully; the output will be video-only MP4.
//
// Engine: the multi-threaded core (decision 0009 §3). All video routes share the
// MT core and carry COOP + COEP headers (public/_headers) for SharedArrayBuffer.
//
// MIME note: browsers report dropped .webm files as "video/webm", but some OS file
// pickers report "" or an alias. We accept the standard type and tolerate empty
// MIME when the extension is .webm — matching the pattern established in MP4→GIF.

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

const IN_NAME = "input.webm";
const OUT_NAME = "output.mp4";

// ── Rotate ───────────────────────────────────────────────────────────────────
// "none" emits no -vf (the byte-identical default). Each rotation maps to ffmpeg
// transpose/flip filters: 90° = transpose=1, 180° = hflip,vflip, 270° = transpose=2.
// NOTE: H.264/yuv420p needs EVEN dimensions, but rotation never makes an even
// dimension odd — transpose swaps W↔H (both already even) and hflip/vflip preserve
// them — so no toEven guard is needed for these filters (cf. video-crop.ts, which
// does need it because the user picks an arbitrary crop size).
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
export interface WebmMp4Options extends AudioSettingsOptions {
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

// Accept video/webm (standard) and tolerate empty MIME when the extension is
// .webm, mirroring the tolerance in the MP4→GIF route.
function isWebmFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/webm") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "webm";
  }
  return false;
}

// Build the audio filter chain (volume + fades) the same way buildAudioArgs does:
// volume (if ≠ 100) → fade-in → fade-out (reverse trick). Returned WITHOUT the
// -af flag so the caller can decide whether to emit it. Empty array ⇒ no filter.
function buildAudioFilters(options: WebmMp4Options): string[] {
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
 * Pure: assemble the full ffmpeg arg array for WEBM→MP4 from (validated) options
 * and the source-matched video bitrate. Mirrors compress-video.ts's
 * buildCompressArgs so tests can assert cheaply.
 *
 * DEFAULTS — rotate none, volume 100, no fades, encoder-default audio bitrate /
 * rate — reproduce the original one-click args BYTE-FOR-BYTE:
 *   -i input.webm -c:v libopenh264 -b:v <n> -pix_fmt yuv420p
 *     -movflags +faststart -c:a aac output.mp4
 *
 * Arg order: -i  [-vf <rotate>]  -c:v libopenh264 -b:v <n>
 *            -pix_fmt yuv420p -movflags +faststart  [-af <audio chain>]
 *            -c:a aac  [-b:a <bitrate>]  [-ar <hz>]  <out>
 * Rotate (-vf) and audio filters (-af) are SEPARATE flags.
 */
export function buildWebmToMp4Args(options: WebmMp4Options = {}, targetBitrate: number): string[] {
  const bitrate = readEnum(options.bitrate, BITRATE_OPTIONS, "auto");
  const sampleRate = readEnum(options.sampleRate, SAMPLE_RATE_OPTIONS, "auto");
  const rotate = readEnum(options.rotate, ROTATE_OPTIONS, DEFAULT_ROTATE);

  const args: string[] = ["-i", IN_NAME];

  // Rotate as -vf, immediately after -i so the encoder sees rotated frames.
  if (rotate !== "none") {
    args.push("-vf", ROTATE_FILTER[rotate]);
  }

  // Video: openh264 H.264, source-matched bitrate, iOS/Safari-compatible pixel
  // format, faststart for streaming.
  args.push(
    "-c:v", "libopenh264",
    "-b:v", String(targetBitrate),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  );

  // Audio filters (volume/fade) as -af, separate from the rotate -vf.
  const audioFilters = buildAudioFilters(options);
  if (audioFilters.length > 0) {
    args.push("-af", audioFilters.join(","));
  }

  // Audio: AAC only (no codec choice), with optional bitrate / sample rate.
  args.push("-c:a", "aac");
  if (bitrate !== "auto") args.push("-b:a", bitrate);
  if (sampleRate !== "auto") args.push("-ar", sampleRate);

  args.push(OUT_NAME);
  return args;
}

async function convertWebmToMp4(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isWebmFile(file)) {
    throw new ConversionError("This doesn't look like a WEBM file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/webm, received "${file.type || "unknown type"}".`,
    });
  }

  const opts = (options ?? {}) as WebmMp4Options;

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

  // openh264's default bitrate is very low — pin it to the source's budget so
  // the H.264 re-encode keeps the WEBM's resolution AND fidelity.
  const targetBitrate = recommendedVideoBitrate(file.size, await probeVideoDuration(file));

  const FFMPEG_ARGS = buildWebmToMp4Args(opts, targetBitrate);

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

  const blob = new Blob([result.data.slice().buffer], { type: "video/mp4" });

  return {
    blob,
    filename: replaceExtension(file.name, "mp4"),
    mimeType: "video/mp4",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// Optional converter controls. DEFAULTS keep the args byte-identical to the
// original one-click H.264/AAC encode (see buildWebmToMp4Args). NO video codec /
// crf / preset controls — libopenh264 offers none of those knobs.
const controls: ControlSchema[] = [
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
  sampleRateControl(),
  bitrateControl("auto"),
  volumeControl(),
  ...fadeControls(),
];

export const webmMp4Descriptor: ConversionDescriptor = {
  id: "webm-to-mp4",
  fromLabel: "WEBM",
  toLabel: "MP4",
  accept: ["video/webm"],
  newExtension: "mp4",
  // Defaults reproduce the original one-click output exactly: no rotate, 100%
  // volume, no fades, encoder-default audio bitrate / rate. The extra controls only
  // change the args when the user moves off these defaults.
  defaultOptions: {
    rotate: DEFAULT_ROTATE,
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
  convert: convertWebmToMp4,
};
