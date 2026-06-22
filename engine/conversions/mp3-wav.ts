// MP3 → WAV. The first FFmpeg-backed route, proving the pattern the rest of the
// audio/video group will follow.
//
// MP3 is a lossy compressed format; WAV is uncompressed LPCM. FFmpeg decodes the
// MP3 frames (libmp3lame's decoder) and re-muxes the raw samples into a WAV
// container — `ffmpeg -i input.mp3 output.wav`. No re-encode quality knob: WAV
// just stores the decoded PCM, so the output is faithful to the decoded MP3 (and
// considerably larger, since it is uncompressed).
//
// Engine: the single-threaded core (decision 0009 §3). Audio files are short, the
// ST core needs no COOP/COEP headers, and that keeps AdSense alive on this page.
//
// MIME note: browsers usually report dropped .mp3 files as "audio/mpeg", but some
// (and some OS file pickers) report "" or "audio/mp3". We accept the standard
// type and tolerate empty/alias values when the extension is .mp3 — same
// philosophy as the HEIC route's empty-MIME tolerance.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";
import {
  buildAudioArgs,
  sampleRateControl,
  channelsControl,
  volumeControl,
  reverseControl,
  trimControls,
  fadeControls,
  type AudioSettingsOptions,
} from "./audio-settings";

// The ffmpeg virtual-FS filenames. Kept simple and constant; runFFmpeg cleans
// them up after each call so the singleton's MEMFS doesn't accumulate files.
const IN_NAME = "input.mp3";
const OUT_NAME = "output.wav";

// ── Advanced audio settings ─────────────────────────────────────────────────
//
// MP3→WAV composes the shared audio drawer: sample rate / channels / volume /
// reverse, plus trim + fade. WAV is uncompressed LPCM, so there is intentionally
// NO bitrate/VBR control here (a `-b:a` flag is a no-op for pcm_s16le, and the
// shared builder never emits one for a lossless codec). The DEFAULTS (everything
// "Auto" / 100% / off / blank) emit NOTHING, so the assembled args reduce to the
// original `-i input.mp3 output.wav` and the out-of-the-box result is unchanged.
//
// WAV is lossless: codec.lossy = false and no -c:a is emitted, matching the
// original behavior of letting the .wav muxer pick pcm_s16le.

// Pure: assemble the full ffmpeg arg array for MP3→WAV from (validated) options.
// Defaults reproduce the original `-i input.mp3 output.wav` exactly.
export function buildMp3WavArgs(options: AudioSettingsOptions | undefined = {}): string[] {
  return buildAudioArgs({
    inName: IN_NAME,
    outName: OUT_NAME,
    codec: { lossy: false },
    options,
  });
}

// Throw the canonical CANCELLED error when the caller has aborted.
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

// Accept audio/mpeg (the standard), and tolerate empty or audio/mp3 MIME when the
// filename ends in .mp3 so files from pickers that mislabel the type still work.
function isMp3File(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "audio/mpeg" || type === "audio/mp3") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "mp3";
  }
  return false;
}

async function convertMp3ToWav(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp3File(file)) {
    throw new ConversionError("This doesn't look like an MP3 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected audio/mpeg, received "${file.type || "unknown type"}".`,
    });
  }

  const ffmpeg = await loadFFmpeg("st");

  throwIfAborted(signal);

  onProgress?.({ stage: "Converting" });

  // ffmpeg's progress event reports a 0..1 ratio. It is only accurate when input
  // and output durations match, which is exactly the case for a straight
  // MP3→WAV remux, so we forward it as the progress ratio. Register on the shared
  // instance just for this conversion and remove it after, so handlers don't
  // accumulate across conversions that reuse the singleton.
  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    // Clamp: ffmpeg can briefly report >1 or a negative as it flushes.
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Converting", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  let result: { data: Uint8Array; exitCode: number };
  try {
    result = await runFFmpeg(ffmpeg, {
      inName: IN_NAME,
      outName: OUT_NAME,
      input: inputBytes,
      args: buildMp3WavArgs(options as AudioSettingsOptions | undefined),
      signal,
    });
  } catch (err) {
    // An abort surfaces here as a thrown error from exec/readFile; map it to
    // CANCELLED rather than DECODE_FAILED so the UI offers a retry.
    if (signal?.aborted) {
      throw new ConversionError("Conversion cancelled.", {
        code: "CANCELLED",
        recoverable: true,
      });
    }
    // Otherwise ffmpeg could not decode/produce the output (corrupt or non-MP3
    // bytes that slipped past the MIME gate, or an internal ffmpeg failure).
    throw new ConversionError(
      "We couldn't convert this audio — the file may be damaged or not a valid MP3.",
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

  // exec resolves with a non-zero code on ffmpeg failure (rather than throwing).
  // An empty output is the other failure signature. Either means decode failed.
  if (result.exitCode !== 0 || result.data.byteLength === 0) {
    throw new ConversionError(
      "We couldn't convert this audio — the file may be damaged or not a valid MP3.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  // Copy into a fresh ArrayBuffer so the Blob owns contiguous bytes independent
  // of the ffmpeg heap view.
  const blob = new Blob([result.data.slice().buffer], { type: "audio/wav" });

  return {
    blob,
    filename: replaceExtension(file.name, "wav"),
    mimeType: "audio/wav",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const mp3WavDescriptor: ConversionDescriptor = {
  id: "mp3-to-wav",
  fromLabel: "MP3",
  toLabel: "WAV",
  accept: ["audio/mpeg"],
  newExtension: "wav",
  // Advanced audio settings. NO bitrate/VBR control: WAV is uncompressed PCM, so
  // a `-b:a` flag would be a no-op. Defaults (everything "Auto" / 100% / off /
  // blank) emit nothing, so the out-of-the-box result is byte-identical to before.
  defaultOptions: {
    sampleRate: "auto",
    channels: "auto",
    volume: 100,
    reverse: false,
    trimStart: "",
    trimEnd: "",
    fadeIn: 0,
    fadeOut: 0,
  },
  controls: [
    sampleRateControl(),
    channelsControl(),
    volumeControl(),
    reverseControl(),
    ...trimControls(),
    ...fadeControls(),
  ],
  // Loads the single-threaded ffmpeg core (decision 0009). The descriptor's
  // loadEngine returns void; we drop loadFFmpeg's resolved instance and let
  // convert fetch the cached singleton.
  loadEngine: async () => {
    await loadFFmpeg("st");
  },
  // The ST core (ffmpeg-core.js + .wasm) is the one-time download shown in the
  // setup state while loadEngine runs.
  setupSizeLabel: "≈ 24 MB",
  convert: convertMp3ToWav,
};
