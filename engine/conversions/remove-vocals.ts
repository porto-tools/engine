// Remove vocals — center-channel cancellation, NOT AI stem separation.
//
// HONEST mechanism: in most stereo mixes the lead vocal is panned dead-center,
// so it is (nearly) identical in the left and right channels. Subtracting one
// channel from the other cancels whatever is common to both — which removes the
// center-panned vocal and leaves the stereo-spread instruments. The exact filter
// is ffmpeg's well-known karaoke pan:
//
//   -af "pan=stereo|c0=c0-c1|c1=c1-c0"
//
//   c0 (new left)  = old left  − old right
//   c1 (new right) = old right − old left
//
// Anything identical in both channels (the center) cancels to silence; anything
// that differs (panned instruments, stereo reverb) survives. Output is MP3 via
// libmp3lame at 192k → audio/mpeg / .mp3, a single file named "*-instrumental.mp3".
//
// LIMITATIONS — stated plainly, no overclaim:
//   • This is NOT AI/ML stem separation. There is no model; it is pure channel math.
//   • It only does anything on a STEREO source. A mono track (both channels equal)
//     cancels to near-silence; a true-mono file has nothing to subtract.
//   • It also removes OTHER center-panned content: bass, kick drum, and snare are
//     usually centered too, so the result can sound thin or lose its low end.
//   • Vocals mixed with stereo width, heavy reverb, or doubling are only partly
//     removed.
//
// Engine: audio-only output → the single-threaded ("st") core, so no COOP/COEP
// headers are needed and AdSense stays alive on this page (same as the other
// audio routes).
//
// Engine firewall: this file imports ONLY ../types, ../filename, ./abort, and
// ./ffmpeg-core (+ node_modules). It never reaches into app/components/lib.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";

// ── Output config ─────────────────────────────────────────────────────────────

const OUTPUT_MIME = "audio/mpeg";
const OUTPUT_EXT = "mp3";
// Distinguish the result from the source: "song.mp3" → "song-instrumental.mp3".
const OUTPUT_SUFFIX = "-instrumental";

// Known audio extensions tolerated when the MIME type is empty (some OS pickers /
// drag-and-drop sources hand over a blank type). Mirrors audio-converter.
const AUDIO_EXTS = new Set([
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif", "aiff",
]);

// The accepted input MIME types — the same broad sweep audio-converter accepts.
// A stereo source is required for cancellation to do anything (see file header).
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

// Pure: the exact ffmpeg arg array for vocal removal. Exported so the filter
// string is unit-testable and locked. The karaoke pan subtracts the opposite
// channel from each channel, cancelling center-panned (vocal) content.
export function buildRemoveVocalsArgs(inName: string, outName: string): string[] {
  return [
    "-i", inName,
    "-af", "pan=stereo|c0=c0-c1|c1=c1-c0",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    outName,
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

// Accept the common audio MIME types, and tolerate empty MIME when the extension
// is a known audio extension (matches audio-converter's tolerance).
function isAudioFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith("audio/") && ACCEPT_MIMES.includes(type)) return true;
  if (type === "") return AUDIO_EXTS.has(fileExt(file.name));
  return false;
}

// Build "<basename>-instrumental.mp3" from the source name. replaceExtension
// gives us "<basename>.mp3" with the last extension stripped; we splice the
// suffix in before the new extension so the result is clearly distinguished from
// the source.
function outputFilename(sourceName: string): string {
  const withMp3 = replaceExtension(sourceName, OUTPUT_EXT); // "song.mp3"
  const dot = withMp3.lastIndexOf(".");
  return `${withMp3.slice(0, dot)}${OUTPUT_SUFFIX}${withMp3.slice(dot)}`;
}

// ── Converter ─────────────────────────────────────────────────────────────────

async function removeVocals(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isAudioFile(file)) {
    throw new ConversionError("This doesn't look like an audio file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Unsupported input type "${file.type || "unknown type"}" (name "${file.name}").`,
    });
  }

  // ffmpeg sniffs the input by content, but giving the temp file the source
  // extension helps demuxer selection. Fall back to a bare "input" name.
  const srcExt = fileExt(file.name);
  const inName = srcExt ? `input.${srcExt}` : "input";
  const outName = `output.${OUTPUT_EXT}`;

  const ffmpeg = await loadFFmpeg("st");

  throwIfAborted(signal);

  onProgress?.({ stage: "Removing vocals" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Removing vocals", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  const FFMPEG_ARGS = buildRemoveVocalsArgs(inName, outName);

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
      "We couldn't process this audio. The file may be damaged or in a format this tool can't read — try a different source file.",
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
      "We couldn't process this audio. The file may be damaged or in a format this tool can't read — try a different source file.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: OUTPUT_MIME });

  return {
    blob,
    filename: outputFilename(file.name),
    mimeType: OUTPUT_MIME,
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// ── Descriptor ────────────────────────────────────────────────────────────────

export const removeVocalsDescriptor: ConversionDescriptor = {
  id: "remove-vocals",
  fromLabel: "Stereo audio",
  toLabel: "Instrumental (MP3)",
  accept: ACCEPT_MIMES,
  newExtension: OUTPUT_EXT,
  loadEngine: async () => {
    await loadFFmpeg("st");
  },
  // The ST core (ffmpeg-core.js + .wasm) is the one-time download shown in the
  // setup state while loadEngine runs.
  setupSizeLabel: "≈ 24 MB",
  convert: removeVocals,
};
