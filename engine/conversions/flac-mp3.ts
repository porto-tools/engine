// FLAC → MP3. Mirrors wav-mp3.ts / m4a-mp3.ts exactly.
//
// FLAC is lossless compressed audio; MP3 is lossy compressed. FFmpeg decodes the
// FLAC stream back to PCM and re-encodes it with libmp3lame at 192 kbps:
//   `ffmpeg -i input.flac -c:a libmp3lame -b:a 192k output.mp3`
// The result is much smaller than the FLAC source and plays on virtually any
// device. Because MP3 is lossy, some fine detail FLAC preserved is discarded in
// the encode — the usual, irreversible cost of compressing to MP3.
//
// The shipped LGPL ffmpeg core already bundles the FLAC decoder and libmp3lame
// encoder (used by audio-converter.ts FORMAT_CONFIG), so this route is 0-dep.
//
// Engine: single-threaded core (decision 0009 §3). No COOP/COEP needed.
//
// MIME note: FLAC is reported as "audio/flac" (standard) or "audio/x-flac" on
// some OS pickers. We also tolerate empty MIME when the extension is .flac.

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

const IN_NAME = "input.flac";
const OUT_NAME = "output.mp3";

// ── Advanced audio settings ─────────────────────────────────────────────────
//
// FLAC→MP3 composes the shared audio drawer: bitrate + VBR + sample rate /
// channels / volume / reverse, plus trim + fade. The DEFAULTS reproduce
// `-i input.flac -c:a libmp3lame -b:a 192k output.mp3`: bitrate defaults to 192k
// with VBR off, and everything else is a no-op ("Auto" / 100% / blank). Pass no
// options and the assembled args — and so the output — are unchanged.
//
// MP3 is lossy via libmp3lame: codec.ffmpegArgs = ["-c:a","libmp3lame"]. The
// shared builder emits `-b:a <bitrate>` (CBR, default) or, with VBR on, a
// `-q:a <V>` quality flag mapped from the chosen bitrate.

// Pure: assemble the full ffmpeg arg array for FLAC→MP3 from (validated) options.
export function buildFlacMp3Args(options: AudioSettingsOptions | undefined = {}): string[] {
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

// Accept audio/flac (standard) and audio/x-flac; tolerate empty MIME with a
// .flac extension.
function isFlacFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "audio/flac" || type === "audio/x-flac") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "flac";
  }
  return false;
}

async function convertFlacToMp3(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isFlacFile(file)) {
    throw new ConversionError("This doesn't look like a FLAC file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected audio/flac (or variant), received "${file.type || "unknown type"}".`,
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
      args: buildFlacMp3Args(options as AudioSettingsOptions | undefined),
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
      "We couldn't convert this audio — the file may be damaged or not a valid FLAC.",
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
      "We couldn't convert this audio — the file may be damaged or not a valid FLAC.",
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

export const flacMp3Descriptor: ConversionDescriptor = {
  id: "flac-to-mp3",
  fromLabel: "FLAC",
  toLabel: "MP3",
  accept: ["audio/flac", "audio/x-flac"],
  newExtension: "mp3",
  // Advanced audio settings. Defaults reproduce a plain `-b:a 192k` encode
  // (bitrate 192k + VBR off, the rest "Auto"/100%/blank).
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
  convert: convertFlacToMp3,
};
