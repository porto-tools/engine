// Generic audio converter — accepts any common audio file and re-encodes it to a
// user-chosen output format. The closest analog is extract-audio.ts (a format
// select FIRST, then the shared audio drawer, then a validate → loadFFmpeg("st")
// → runFFmpeg → blob pipeline). Two differences from extract-audio: the input is
// ANY audio (not mp4), and there is NO `-vn` (no video stream to strip).
//
// Output formats and the codec / container / MIME each one uses:
//
//   mp3  →  -c:a libmp3lame   (audio/mpeg, .mp3)   lossy, VBR via libmp3lame
//   wav  →  -c:a pcm_s16le    (audio/wav,  .wav)   lossless
//   m4a  →  -c:a aac          (audio/mp4,  .m4a)   lossy, VBR via native aac
//   aac  →  -c:a aac          (audio/aac,  .aac)   lossy (raw ADTS), VBR via aac
//   flac →  -c:a flac         (audio/flac, .flac)  lossless
//   ogg  →  -c:a libvorbis    (audio/ogg,  .ogg)   lossy, encoder-default VBR
//   opus →  -c:a libopus      (audio/ogg,  .opus)  lossy, encoder-default VBR
//   aiff →  -c:a pcm_s16be    (audio/aiff, .aiff)  lossless
//
// All eight encoders (libmp3lame, libvorbis, libopus, native aac, flac, pcm) are
// already bundled in the single-threaded ffmpeg core — 0 new deps. Audio-only
// output → ST core, no COOP/COEP headers, AdSense stays alive on this page.
//
// HONESTY: the lossless outputs (flac/wav/aiff) do NOT recover detail a lossy
// source already discarded — converting an MP3 to FLAC just stores the MP3's
// already-degraded audio in a lossless container (a larger file, same quality).
//
// ogg/opus carry no VBR mapping (vbrEncoder is left undefined), so the shared
// builder's VBR branch is a harmless no-op for them and a chosen bitrate maps to
// a plain `-b:a` instead — see audio-settings.ts.
//
// Engine firewall: this file imports ONLY ../types, ../filename, ./ffmpeg-core,
// and ./audio-settings. It never reaches into app/components/lib.

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

type AudioFormat = "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "aiff";

interface FormatConfig {
  codec: string;
  mimeType: string;
  ext: string;
  // The shared-builder codec descriptor for this output. Lossless formats
  // (wav/flac/aiff) are `lossy: false` so bitrate/VBR are NEVER emitted; lossy
  // formats set the encoder and, where a VBR `-q:a` scale exists, a vbrEncoder.
  audioCodec: AudioCodec;
}

export const FORMAT_CONFIG: Record<AudioFormat, FormatConfig> = {
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
  aac: {
    // Raw ADTS .aac stream (not in an MP4 container). Same encoder as m4a.
    codec: "aac",
    mimeType: "audio/aac",
    ext: "aac",
    audioCodec: { lossy: true, ffmpegArgs: ["-c:a", "aac"], vbrEncoder: "aac" },
  },
  flac: {
    codec: "flac",
    mimeType: "audio/flac",
    ext: "flac",
    audioCodec: { lossy: false, ffmpegArgs: ["-c:a", "flac"] },
  },
  ogg: {
    // No vbrEncoder: libvorbis has no `-q:a` mapping wired here, so VBR is a
    // harmless no-op and a chosen bitrate maps to `-b:a`.
    codec: "libvorbis",
    mimeType: "audio/ogg",
    ext: "ogg",
    audioCodec: { lossy: true, ffmpegArgs: ["-c:a", "libvorbis"] },
  },
  opus: {
    // Opus is carried in an Ogg container; the .opus extension is the convention.
    // MIME audio/ogg is the broadly-supported choice (audio/opus is not widely
    // recognised by browsers / OS pickers).
    codec: "libopus",
    mimeType: "audio/ogg",
    ext: "opus",
    audioCodec: { lossy: true, ffmpegArgs: ["-c:a", "libopus"] },
  },
  aiff: {
    codec: "pcm_s16be",
    mimeType: "audio/aiff",
    ext: "aiff",
    audioCodec: { lossy: false, ffmpegArgs: ["-c:a", "pcm_s16be"] },
  },
};

const DEFAULT_FORMAT: AudioFormat = "mp3";

// Known audio extensions tolerated when the MIME type is empty (some OS pickers /
// drag-and-drop sources hand over a blank type).
const AUDIO_EXTS = new Set([
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif", "aiff",
]);

// The accepted input MIME types — a broad sweep of the common audio types and
// their observed variants.
const ACCEPT_MIMES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/opus",
  "audio/aiff",
  "audio/x-aiff",
  "audio/3gpp",
];

// ── Builder ─────────────────────────────────────────────────────────────────

// Pure: assemble the full ffmpeg arg array for an audio conversion. No
// preCodecArgs — the input is audio, so there is no video stream to strip.
export function buildAudioConverterArgs(
  inName: string,
  outName: string,
  audioCodec: AudioCodec,
  options: AudioSettingsOptions | undefined = {},
): string[] {
  return buildAudioArgs({ inName, outName, codec: audioCodec, options });
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

function fileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

// Accept the common audio MIME types, and tolerate empty MIME when the extension
// is a known audio extension.
function isAudioFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith("audio/") && ACCEPT_MIMES.includes(type)) return true;
  if (type === "") return AUDIO_EXTS.has(fileExt(file.name));
  return false;
}

// Read the format control value defensively; fall back to DEFAULT_FORMAT.
function resolveFormat(options: Record<string, unknown> | undefined): AudioFormat {
  const raw = options?.format;
  if (typeof raw === "string" && raw in FORMAT_CONFIG) {
    return raw as AudioFormat;
  }
  return DEFAULT_FORMAT;
}

// ── Converter ─────────────────────────────────────────────────────────────────

async function convertAudio(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isAudioFile(file)) {
    throw new ConversionError("This doesn't look like an audio file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Unsupported input type "${file.type || "unknown type"}" (name "${file.name}").`,
    });
  }

  const format = resolveFormat(options);
  const { audioCodec, mimeType, ext } = FORMAT_CONFIG[format];

  // ffmpeg sniffs the input by content, but giving the temp file the source
  // extension helps demuxer selection. Fall back to a bare "input" name.
  const srcExt = fileExt(file.name);
  const inName = srcExt ? `input.${srcExt}` : "input";
  const outName = `output.${ext}`;

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

  const FFMPEG_ARGS = buildAudioConverterArgs(
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
      "We couldn't convert this audio. The file may be damaged or in a format this tool can't read — try a different source file.",
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
      "We couldn't convert this audio. The file may be damaged or in a format this tool can't read — try a different source file.",
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

export const audioConverterDescriptor: ConversionDescriptor = {
  id: "audio-converter",
  fromLabel: "Audio",
  toLabel: "Any format",
  accept: ACCEPT_MIMES,
  newExtension: "mp3", // overridden per conversion by resolveFormat
  controls: [
    // Route-specific format select stays FIRST; the shared audio drawer follows.
    {
      type: "select",
      id: "format",
      label: "Output format",
      default: "mp3",
      options: [
        { value: "mp3", label: "MP3 — universal, small (lossy)" },
        { value: "wav", label: "WAV — uncompressed (lossless)" },
        { value: "m4a", label: "M4A / AAC in MP4 (lossy)" },
        { value: "aac", label: "AAC — raw ADTS stream (lossy)" },
        { value: "flac", label: "FLAC — compressed (lossless)" },
        { value: "ogg", label: "OGG Vorbis (lossy)" },
        { value: "opus", label: "Opus — efficient (lossy)" },
        { value: "aiff", label: "AIFF — uncompressed (lossless)" },
      ],
    },
    // Bitrate defaults to "auto" (the encoder picks its own default). Ignored
    // entirely for the lossless formats (wav/flac/aiff).
    bitrateControl("auto"),
    vbrControl(),
    sampleRateControl(),
    channelsControl(),
    volumeControl(),
    reverseControl("Play the converted audio backwards."),
    ...trimControls(),
    ...fadeControls(),
  ],
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
  convert: convertAudio,
};
