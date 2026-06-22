// Extract audio from an MP4 — the first parameterized audio-extraction tool.
//
// The user chooses the output format (MP3, WAV, or M4A) via a select control.
// FFmpeg strips the video stream with `-vn` and encodes the audio track with the
// appropriate codec:
//
//   mp3  →  -c:a libmp3lame  (output: output.mp3, MIME: audio/mpeg)
//   wav  →  -c:a pcm_s16le   (output: output.wav, MIME: audio/wav)
//   m4a  →  -c:a aac         (output: output.m4a, MIME: audio/mp4)
//
// Engine: the single-threaded core. Audio-only output → ST core, no
// COOP/COEP headers needed, AdSense stays alive on this page.

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
  type AudioCodec,
  type AudioSettingsOptions,
} from "./audio-settings";

// ── Format config ─────────────────────────────────────────────────────────────

type AudioFormat = "mp3" | "wav" | "m4a";

interface FormatConfig {
  codec: string;
  mimeType: string;
  ext: AudioFormat;
  // The shared-builder codec descriptor for this output: WAV is lossless (no
  // bitrate/VBR), MP3/M4A are lossy with a VBR-capable encoder.
  audioCodec: AudioCodec;
}

const FORMAT_CONFIG: Record<AudioFormat, FormatConfig> = {
  mp3: {
    codec: "libmp3lame",
    mimeType: "audio/mpeg",
    ext: "mp3",
    audioCodec: { lossy: true, ffmpegArgs: ["-c:a", "libmp3lame"], vbrEncoder: "libmp3lame" },
  },
  wav: {
    codec: "pcm_s16le",
    mimeType: "audio/wav",
    ext: "wav",
    audioCodec: { lossy: false, ffmpegArgs: ["-c:a", "pcm_s16le"] },
  },
  m4a: {
    codec: "aac",
    mimeType: "audio/mp4",
    ext: "m4a",
    audioCodec: { lossy: true, ffmpegArgs: ["-c:a", "aac"], vbrEncoder: "aac" },
  },
};

const DEFAULT_FORMAT: AudioFormat = "mp3";

// ── Advanced audio settings ─────────────────────────────────────────────────
//
// Extract-audio keeps its format select and composes the same shared audio
// drawer as the four converter tools: bitrate + VBR + sample rate / channels /
// volume / reverse, plus trim + fade. The DEFAULTS reproduce the original
// `-i <in> -vn -c:a <codec> <out>` command exactly: bitrate defaults to "Auto"
// (emits NOTHING, leaving the codec's own default), and everything else is a
// no-op ("Auto" / 100% / off / blank). Pass no options beyond `format` and the
// output is unchanged.
//
// The shared builder injects `-vn` via preCodecArgs (right after `-i`, before
// the codec select) so the original arg order is preserved. Bitrate/VBR are
// never emitted for the WAV/PCM (lossless) format.

// Pure: assemble the full ffmpeg arg array for extract-audio from the resolved
// format/codec descriptor/filenames and (validated) advanced options. Defaults
// reproduce the original `-i <in> -vn -c:a <codec> <out>` exactly.
export function buildExtractAudioArgs(
  inName: string,
  outName: string,
  audioCodec: AudioCodec,
  options: AudioSettingsOptions | undefined = {},
): string[] {
  return buildAudioArgs({
    inName,
    outName,
    codec: audioCodec,
    options,
    preCodecArgs: ["-vn"],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Read the format control value defensively; fall back to DEFAULT_FORMAT when
// the option is absent, not a string, or not a recognised format key.
function resolveFormat(options: Record<string, unknown> | undefined): AudioFormat {
  const raw = options?.format;
  if (typeof raw === "string" && raw in FORMAT_CONFIG) {
    return raw as AudioFormat;
  }
  return DEFAULT_FORMAT;
}

// ── Converter ─────────────────────────────────────────────────────────────────

async function convertExtractAudio(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  const format = resolveFormat(options);
  const { audioCodec, mimeType, ext } = FORMAT_CONFIG[format];

  const inName = "input.mp4";
  const outName = `output.${ext}`;

  const ffmpeg = await loadFFmpeg("st");

  throwIfAborted(signal);

  onProgress?.({ stage: "Extracting audio" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Extracting audio", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // -vn strips the video stream; -c:a <codec> encodes (or re-muxes) the audio.
  // The advanced settings (bitrate/VBR/sampleRate/channels/volume/reverse/trim/
  // fade) fold in via buildExtractAudioArgs; defaults reproduce the original
  // command exactly.
  const FFMPEG_ARGS = buildExtractAudioArgs(
    inName,
    outName,
    audioCodec,
    options as AudioSettingsOptions | undefined,
  );

  let result: { data: Uint8Array; exitCode: number };
  try {
    result = await runFFmpeg(ffmpeg, {
      inName,
      outName,
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
      "We couldn't extract the audio from this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't extract the audio from this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: mimeType });

  return {
    blob,
    filename: replaceExtension(file.name, ext),
    mimeType,
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// ── Descriptor ────────────────────────────────────────────────────────────────

export const extractAudioDescriptor: ConversionDescriptor = {
  id: "extract-audio",
  fromLabel: "MP4",
  toLabel: "Audio",
  accept: ["video/mp4"],
  newExtension: "mp3", // overridden per conversion by resolveFormat
  controls: [
    // Route-specific format select stays FIRST; the shared audio drawer follows.
    {
      type: "select",
      id: "format",
      label: "Output format",
      default: "mp3",
      options: [
        { value: "mp3", label: "MP3" },
        { value: "wav", label: "WAV" },
        { value: "m4a", label: "M4A" },
      ],
    },
    // Bitrate defaults to "auto" here (the route never set one), so the original
    // codec-default command is reproduced. Bitrate/VBR are ignored for WAV.
    bitrateControl("auto"),
    vbrControl(),
    sampleRateControl(),
    channelsControl(),
    volumeControl(),
    reverseControl("Play the extracted audio backwards."),
    ...trimControls(),
    ...fadeControls(),
  ],
  // Defaults reproduce the original `-vn -c:a <codec>` command: bitrate "Auto"
  // (no -b:a) + VBR off, sample rate / channels "Auto", volume 100%, reverse off,
  // no trim, no fade.
  defaultOptions: {
    format: "mp3",
    bitrate: "auto",
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
  loadEngine: async () => {
    await loadFFmpeg("st");
  },
  // The ST core (ffmpeg-core.js + .wasm) is the one-time download shown in the
  // setup state while loadEngine runs.
  setupSizeLabel: "≈ 24 MB",
  convert: convertExtractAudio,
};
