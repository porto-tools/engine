// MP3 → M4A. Mirrors the mp3-wav.ts pattern exactly.
//
// Both MP3 and M4A (AAC inside an MPEG-4 container) are lossy compressed
// formats. FFmpeg decodes the MP3 frames and re-encodes using the native AAC
// encoder (`-c:a aac`) at 192 kbps — this LGPL build does NOT bundle libfdk_aac:
//   `ffmpeg -i input.mp3 -c:a aac -b:a 192k output.m4a`
// Because both source and output are lossy, there is a small quality cost from
// re-encoding — the same generation loss that applies to any transcode between
// lossy codecs. 192 kbps AAC is perceptually equivalent to ~256 kbps MP3, so
// the output quality should be very close in practice.
//
// Engine: single-threaded core (decision 0009 §3). No COOP/COEP needed.
//
// MIME note: browsers report .mp3 files as "audio/mpeg" (standard) but some
// pickers or OS paths emit "audio/mp3" or even empty. We accept both explicit
// types and tolerate empty MIME when the extension is .mp3.

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
  bitrateControl,
  vbrControl,
  trimControls,
  fadeControls,
  type AudioSettingsOptions,
} from "./audio-settings";

const IN_NAME = "input.mp3";
const OUT_NAME = "output.m4a";

// ── Advanced audio settings ─────────────────────────────────────────────────
//
// MP3→M4A composes the shared audio drawer: bitrate + VBR + sample rate /
// channels / volume / reverse, plus trim + fade. The DEFAULTS reproduce the
// original `-i input.mp3 -c:a aac -b:a 192k output.m4a`: the AAC codec flag is
// always emitted; bitrate defaults to 192k with VBR off; everything else is a
// no-op ("Auto" / 100% / blank). Pass no options and the output is unchanged.
//
// M4A is lossy via the native aac encoder: codec.ffmpegArgs = ["-c:a","aac"].
// The shared builder emits `-b:a <bitrate>` (CBR, default) or, with VBR on, a
// `-q:a <n>` per-stream quality flag mapped from the chosen bitrate.

// Pure: assemble the full ffmpeg arg array for MP3→M4A from (validated) options.
// Defaults reproduce `-i input.mp3 -c:a aac -b:a 192k output.m4a` exactly.
export function buildMp3M4aArgs(options: AudioSettingsOptions | undefined = {}): string[] {
  return buildAudioArgs({
    inName: IN_NAME,
    outName: OUT_NAME,
    codec: { lossy: true, ffmpegArgs: ["-c:a", "aac"], vbrEncoder: "aac" },
    options,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

// Accept audio/mpeg (standard) and audio/mp3 (alias), tolerate empty MIME + .mp3.
function isMp3File(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "audio/mpeg" || type === "audio/mp3") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "mp3";
  }
  return false;
}

async function convertMp3ToM4a(input: ConversionInput): Promise<ConversionResult> {
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

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
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
      args: buildMp3M4aArgs(options as AudioSettingsOptions | undefined),
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

  const blob = new Blob([result.data.slice().buffer], { type: "audio/mp4" });

  return {
    blob,
    filename: replaceExtension(file.name, "m4a"),
    mimeType: "audio/mp4",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const mp3M4aDescriptor: ConversionDescriptor = {
  id: "mp3-to-m4a",
  fromLabel: "MP3",
  toLabel: "M4A",
  accept: ["audio/mpeg", "audio/mp3"],
  newExtension: "m4a",
  // Advanced audio settings. Defaults reproduce the original `-c:a aac -b:a 192k`
  // encode (bitrate 192k + VBR off, the rest "Auto"/100%/blank), so the result is
  // byte-identical to before.
  defaultOptions: {
    bitrate: "192k",
    vbr: false,
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
    bitrateControl("192k"),
    vbrControl(),
    sampleRateControl(),
    channelsControl(),
    volumeControl(),
    reverseControl(),
    ...trimControls(),
    ...fadeControls(),
  ],
  loadEngine: async () => {
    await loadFFmpeg("st");
  },
  setupSizeLabel: "≈ 24 MB",
  convert: convertMp3ToM4a,
};
