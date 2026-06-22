// M4A → MP3. Mirrors the mp3-wav.ts pattern exactly.
//
// M4A (AAC audio in an MPEG-4 container) and MP3 are both lossy formats. FFmpeg
// decodes the AAC stream and re-encodes with libmp3lame at 192 kbps:
//   `ffmpeg -i input.m4a -b:a 192k output.mp3`
// Because both source and output are lossy, there is a small quality cost from
// re-encoding — the same generation loss that applies to any transcode between
// lossy codecs. The resulting MP3 is maximally compatible with players and
// hardware that do not support AAC/M4A.
//
// Engine: single-threaded core (decision 0009 §3). No COOP/COEP needed.
//
// MIME note: M4A files are reported as "audio/mp4" (the standard container
// MIME) or the more specific "audio/x-m4a" / "audio/m4a" on macOS and some
// iOS pickers. "audio/aac" is observed when the file is a raw AAC stream. We
// also tolerate empty MIME when the extension is .m4a or .aac.

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

const IN_NAME = "input.m4a";
const OUT_NAME = "output.mp3";

// ── Advanced audio settings ─────────────────────────────────────────────────
//
// M4A→MP3 composes the shared audio drawer: bitrate + VBR + sample rate /
// channels / volume / reverse, plus trim + fade. The DEFAULTS reproduce the
// original `-i input.m4a -b:a 192k output.mp3`: bitrate defaults to 192k with VBR
// off, and everything else is a no-op ("Auto" / 100% / blank). Pass no options
// and the assembled args — and so the output — are unchanged.
//
// MP3 is lossy via libmp3lame: codec.ffmpegArgs = ["-c:a","libmp3lame"]. The
// shared builder emits `-b:a <bitrate>` (CBR, default) or, with VBR on, a
// `-q:a <V>` quality flag mapped from the chosen bitrate.

// Pure: assemble the full ffmpeg arg array for M4A→MP3 from (validated) options.
// Defaults reproduce the original `-i input.m4a -b:a 192k output.mp3` exactly.
export function buildM4aMp3Args(options: AudioSettingsOptions | undefined = {}): string[] {
  return buildAudioArgs({
    inName: IN_NAME,
    outName: OUT_NAME,
    codec: { lossy: true, ffmpegArgs: ["-c:a", "libmp3lame"], vbrEncoder: "libmp3lame" },
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

// Accept audio/mp4 (standard), audio/x-m4a, audio/m4a, audio/aac; tolerate
// empty MIME with .m4a or .aac extension.
function isM4aFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (
    type === "audio/mp4" ||
    type === "audio/x-m4a" ||
    type === "audio/m4a" ||
    type === "audio/aac"
  )
    return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "m4a" || ext === "aac";
  }
  return false;
}

async function convertM4aToMp3(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isM4aFile(file)) {
    throw new ConversionError("This doesn't look like an M4A file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected audio/mp4 (or M4A variant), received "${file.type || "unknown type"}".`,
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
      args: buildM4aMp3Args(options as AudioSettingsOptions | undefined),
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
      "We couldn't convert this audio — the file may be damaged or not a valid M4A.",
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
      "We couldn't convert this audio — the file may be damaged or not a valid M4A.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: "audio/mpeg" });

  return {
    blob,
    filename: replaceExtension(file.name, "mp3"),
    mimeType: "audio/mpeg",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const m4aMp3Descriptor: ConversionDescriptor = {
  id: "m4a-to-mp3",
  fromLabel: "M4A",
  toLabel: "MP3",
  accept: ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"],
  newExtension: "mp3",
  // Advanced audio settings. Defaults reproduce the original `-b:a 192k` encode
  // (bitrate 192k + VBR off, the rest "Auto"/100%/blank), so the out-of-the-box
  // result is byte-identical to before.
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
  convert: convertM4aToMp3,
};
