// Shared audio settings — the one place the audio converter routes get their
// advanced-settings interface, validation helpers, control fragments, and the
// pure ffmpeg arg builder. Four converter routes (mp3↔wav, mp3↔m4a) plus
// extract-audio used to DUPLICATE every line of this; they now compose from
// here (DRY).
//
// Engine firewall: this file imports ONLY the sibling types module and
// node_modules. It never reaches into app/components/lib. See types.ts.
//
// DEFAULTS EMIT NOTHING beyond a route's original minimal args. Every reader
// falls back to a no-op ("auto" / 100% / off / blank), and buildAudioArgs only
// appends a flag when a value is non-default — so each route's out-of-the-box
// output stays byte-identical to before the shared module existed.

import type { ControlSchema } from "../types";
import { clampInt } from "./numbers";

// ── Option shape ─────────────────────────────────────────────────────────────
//
// One interface covering every knob any audio route can expose. A given route
// only wires up the controls it wants (e.g. WAV omits bitrate/vbr), but the
// builder reads the whole bag defensively — an absent key reads as its no-op
// default. All fields are `unknown` because the values arrive from the UI's
// untyped ControlValues bag and must be validated here.

export interface AudioSettingsOptions {
  sampleRate?: unknown;
  channels?: unknown;
  volume?: unknown;
  reverse?: unknown;
  bitrate?: unknown;
  vbr?: unknown;
  trimStart?: unknown;
  trimEnd?: unknown;
  fadeIn?: unknown;
  fadeOut?: unknown;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const SAMPLE_RATE_OPTIONS = ["auto", "22050", "32000", "44100", "48000"] as const;
const DEFAULT_SAMPLE_RATE = "auto";

export const CHANNELS_OPTIONS = ["auto", "1", "2"] as const;
const DEFAULT_CHANNELS = "auto";

export const VOLUME_MIN = 50;
export const VOLUME_MAX = 200;
export const VOLUME_DEFAULT = 100;

// Bitrate values carry their "k" suffix so they map straight to `-b:a <value>`.
// "auto" emits nothing (the encoder picks its own default). The order is
// high→low to read naturally in the select.
export const BITRATE_OPTIONS = ["auto", "320k", "256k", "192k", "128k", "96k", "64k"] as const;
const DEFAULT_BITRATE = "auto";

// Fade length bounds (seconds). 0 = no fade (the no-op default).
const FADE_MIN = 0;
const FADE_MAX = 60;
const FADE_DEFAULT = 0;

// ── Readers ──────────────────────────────────────────────────────────────────

// Return `value` if it's one of `allowed`, else `fallback`.
export function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

// Coerce, reject non-finite, round, clamp to range. Re-exported from the shared
// numbers module (folded into clampInt) so there is a single home for this
// clamp; the name and signature are preserved for this module's call sites and
// the routes that import readClampedInt from here.
export const readClampedInt = clampInt;

// Coerce a checkbox value to a real boolean. The UI sends `true`, but options
// that round-trip through strings can arrive as "true".
export function readBool(value: unknown): boolean {
  return value === true || value === "true";
}

// Format the volume factor (pct/100) without trailing zeros, e.g. 150 → "1.5",
// 100 → "1", 175 → "1.75". Keeps the emitted filter string tidy and stable.
export function volumeFactor(pct: number): string {
  return String(Number((pct / 100).toFixed(4)));
}

// ── Timecode parsing ─────────────────────────────────────────────────────────

// Pure: parse a user-typed timecode into seconds, or null when it isn't a valid
// time. Accepts "SS", "MM:SS", "HH:MM:SS", any of which may carry a fractional
// ".ms" tail on the seconds field (e.g. "1:02.5", "90.25"). Rejects garbage,
// empty strings, negative values, and out-of-range minutes/seconds (≥ 60). The
// emitted value is a plain number of seconds, which ffmpeg accepts directly as
// the `atrim` start/end bounds. Returns null (not 0) for invalid input so the
// builder can tell "blank field" apart from "0 seconds".
export function parseTimecode(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const parts = trimmed.split(":");
  if (parts.length === 0 || parts.length > 3) return null;

  // The seconds field (always the last part) may have a fractional tail; the
  // hour/minute fields must be plain non-negative integers.
  const secondsPart = parts[parts.length - 1];
  const headParts = parts.slice(0, -1);

  if (!/^\d+(\.\d+)?$/.test(secondsPart)) return null;
  for (const p of headParts) {
    if (!/^\d+$/.test(p)) return null;
  }

  const seconds = Number(secondsPart);
  // In "MM:SS" / "HH:MM:SS" form the seconds (and minutes) must be < 60. A bare
  // "SS" form (no colons) may exceed 60 — "90" legitimately means 90 seconds.
  if (parts.length > 1 && seconds >= 60) return null;

  let total = seconds;
  if (headParts.length >= 1) {
    const minutes = Number(headParts[headParts.length - 1]);
    if (minutes >= 60) return null;
    total += minutes * 60;
  }
  if (headParts.length === 2) {
    total += Number(headParts[0]) * 3600;
  }
  return total;
}

// ── VBR quality mapping ──────────────────────────────────────────────────────
//
// When VBR is on we emit a per-codec QUALITY flag instead of a fixed `-b:a`
// bitrate. ffmpeg's two relevant encoders both spell it `-q:a <n>`, but with
// very different scales — so we map the user's chosen target bitrate to the
// nearest quality level for that codec.
//
//   libmp3lame: `-q:a <n>`, n = 0..9, LOWER is better quality / larger file.
//               This is exactly LAME's -V VBR scale (V0 ≈ 245 kbps … V9 ≈ 65).
//   native aac: `-q:a <n>`, n is a per-stream quality scalar (~0.1 … 2.0),
//               HIGHER is better. (The `-vbr 1..5` flag belongs to libfdk_aac,
//               which this LGPL build does NOT include — so for the native `aac`
//               encoder `-q:a` is the correct VBR control. Verified against the
//               FFmpeg AAC encoder docs.)
//
// We only emit a VBR flag when the user picked a concrete target bitrate; with
// bitrate "auto" + vbr on there is no target to map, so we emit nothing and let
// the encoder use its own default (still a no-op relative to plain auto).

type VbrCodec = "libmp3lame" | "aac";

// libmp3lame -V level per target bitrate (LAME's published VBR ↔ kbps guide).
const LAME_VBR_BY_BITRATE: Record<string, string> = {
  "320k": "0",
  "256k": "0",
  "192k": "2",
  "128k": "4",
  "96k": "6",
  "64k": "8",
};

// native aac per-stream quality per target bitrate. Higher = better; these map
// the same target bitrates onto the aac encoder's usable VBR band.
// NOTE: native-aac VBR (`-q:a`) is experimental in FFmpeg and carries no
// guaranteed kbps correspondence — these are best-effort approximations, not a
// contract that the output lands at the named bitrate.
const AAC_VBR_BY_BITRATE: Record<string, string> = {
  "320k": "2",
  "256k": "1.8",
  "192k": "1.5",
  "128k": "1.1",
  "96k": "0.8",
  "64k": "0.5",
};

function vbrQuality(codec: VbrCodec, bitrate: string): string | null {
  const table = codec === "libmp3lame" ? LAME_VBR_BY_BITRATE : AAC_VBR_BY_BITRATE;
  return table[bitrate] ?? null;
}

// ── Codec descriptor ─────────────────────────────────────────────────────────
//
// Describes the OUTPUT for buildAudioArgs. `lossy` gates bitrate/vbr (they are
// never emitted for a lossless WAV/PCM target). `ffmpegArgs` is the codec-select
// fragment placed right after `-i` (e.g. ["-c:a","libmp3lame"]); omit it to let
// ffmpeg pick the muxer's default codec (WAV → pcm_s16le), matching the original
// `-i input.mp3 output.wav` behavior. `vbrEncoder` names which `-q:a` scale to
// use when vbr is on; absent ⇒ this codec has no VBR mapping.

export interface AudioCodec {
  lossy: boolean;
  ffmpegArgs?: string[];
  vbrEncoder?: VbrCodec;
}

// ── The pure arg builder ─────────────────────────────────────────────────────

interface BuildAudioArgsParams {
  inName: string;
  outName: string;
  codec: AudioCodec;
  options?: AudioSettingsOptions;
  // Extra flags emitted immediately after `-i` and BEFORE the codec select —
  // used by extract-audio to inject `-vn` (strip the video stream). Defaults to
  // none, so the converter routes are unaffected.
  preCodecArgs?: string[];
}

/**
 * Pure: assemble the full ffmpeg arg array for an audio conversion from the
 * (validated) advanced options and an output codec descriptor.
 *
 * Arg order (each segment only appears when non-default):
 *   -i <in>  [preCodecArgs]  [codec.ffmpegArgs]
 *   [-filter:a <chain>]  [bitrate | vbr]  [-ar <hz>]  [-ac <n>]  <out>
 *
 * Trim placement — INSIDE the filter chain via `atrim`, NOT as output-side
 * `-ss`/`-to`. This is load-bearing: the chain also contains the fade-out
 * "reverse trick" (`areverse,afade,areverse`), which reverses the ENTIRE stream
 * it is handed. If trim were output seeking (`-ss`/`-to` after `-i`), ffmpeg
 * would still decode the full stream into the filter graph, so `areverse` would
 * operate on the untrimmed audio and the fade-out would land at the real file
 * end — OUTSIDE the trimmed window — and the output-side `-to` would then chop
 * the faded tail off. Emitting trim as the FIRST filters fixes this: every
 * later filter sees only the trimmed segment, so the fade lands at the trimmed
 * end. `asetpts=N/SR/TB` resets the trimmed segment's timestamps to start at 0,
 * so fade offsets (st=0) and `areverse` line up with the real trimmed start.
 *
 * Filter chain (a single `-filter:a`, in this fixed order):
 *   atrim+asetpts (if trim) → areverse (if reverse) → volume (if ≠ 100)
 *     → fade-in → fade-out
 * ffmpeg honours only the LAST `-filter:a`, so everything folds into one chain.
 *
 * Fade-out WITHOUT a duration probe: implemented with the reverse trick —
 * `areverse, afade=t=in:st=0:d=<n>, areverse`. Reversing puts the real END at
 * the front, where a fade-IN of length n is applied from t=0, then we reverse
 * back. This fades the tail out correctly without ever needing the clip length.
 */
export function buildAudioArgs({
  inName,
  outName,
  codec,
  options = {},
  preCodecArgs = [],
}: BuildAudioArgsParams): string[] {
  const sampleRate = readEnum(options.sampleRate, SAMPLE_RATE_OPTIONS, DEFAULT_SAMPLE_RATE);
  const channels = readEnum(options.channels, CHANNELS_OPTIONS, DEFAULT_CHANNELS);
  const volume = readClampedInt(options.volume, VOLUME_MIN, VOLUME_MAX, VOLUME_DEFAULT);
  const reverse = readBool(options.reverse);
  const bitrate = readEnum(options.bitrate, BITRATE_OPTIONS, DEFAULT_BITRATE);
  const vbr = readBool(options.vbr);
  const trimStart = parseTimecode(options.trimStart);
  const trimEnd = parseTimecode(options.trimEnd);
  const fadeIn = readClampedInt(options.fadeIn, FADE_MIN, FADE_MAX, FADE_DEFAULT);
  const fadeOut = readClampedInt(options.fadeOut, FADE_MIN, FADE_MAX, FADE_DEFAULT);

  const args: string[] = ["-i", inName, ...preCodecArgs];
  if (codec.ffmpegArgs) args.push(...codec.ffmpegArgs);

  // Single filter chain in a fixed order. Trim leads so that EVERY later filter
  // (notably the fade-out reverse trick) operates on the trimmed segment rather
  // than the full decoded stream — see the header comment for why `atrim` must
  // precede `areverse`.
  const filters: string[] = [];

  // Trim → atrim, as the FIRST filters. Only emit a bound that parsed; include
  // start, end, or both as the user set them. asetpts then rebases the trimmed
  // segment's timestamps to 0 so fade offsets (st=0) and areverse align with the
  // real trimmed start.
  if (trimStart !== null || trimEnd !== null) {
    const bounds: string[] = [];
    if (trimStart !== null) bounds.push(`start=${trimStart}`);
    if (trimEnd !== null) bounds.push(`end=${trimEnd}`);
    filters.push(`atrim=${bounds.join(":")}`, "asetpts=N/SR/TB");
  }

  if (reverse) filters.push("areverse");
  if (volume !== VOLUME_DEFAULT) filters.push(`volume=${volumeFactor(volume)}`);
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) {
    // Reverse trick: fade the tail out without knowing the clip duration. With
    // atrim leading the chain, the reversed stream is the TRIMMED segment, so
    // this fade lands at the trimmed end — and, when reverse=true above, the
    // chain holds three `areverse` filters: the user's reverse plays the trimmed
    // clip backwards, then this pair (reverse → fade-in → reverse) fades the END
    // of that reversed playback. The parity is intentional and TESTED.
    filters.push("areverse", `afade=t=in:st=0:d=${fadeOut}`, "areverse");
  }
  if (filters.length > 0) args.push("-filter:a", filters.join(","));

  // Bitrate / VBR — lossy codecs only; never emitted for WAV/PCM.
  if (codec.lossy && bitrate !== "auto") {
    if (vbr && codec.vbrEncoder) {
      const q = vbrQuality(codec.vbrEncoder, bitrate);
      if (q !== null) args.push("-q:a", q);
    } else if (!vbr) {
      args.push("-b:a", bitrate);
    }
  }

  if (sampleRate !== "auto") args.push("-ar", sampleRate);
  if (channels !== "auto") args.push("-ac", channels);
  args.push(outName);
  return args;
}

// ── Control fragments ────────────────────────────────────────────────────────
//
// Small composable factories returning the existing control objects. Routes
// compose their control set from these (plus any route-specific control like
// extract-audio's format select). Every fragment reuses an existing control
// KIND — no new kinds are introduced. The `default`s here are the no-op values,
// so a route that drops these in unchanged stays byte-identical out of the box.

export function sampleRateControl(): ControlSchema {
  return {
    type: "select",
    id: "sampleRate",
    label: "Sample rate",
    help: "44,100 Hz = CD quality, 48,000 Hz = DVD. Auto keeps the source rate.",
    default: DEFAULT_SAMPLE_RATE,
    options: [
      { value: "auto", label: "Auto (keep source)" },
      { value: "22050", label: "22,050 Hz" },
      { value: "32000", label: "32,000 Hz" },
      { value: "44100", label: "44,100 Hz — CD quality" },
      { value: "48000", label: "48,000 Hz — DVD" },
    ],
  };
}

export function channelsControl(): ControlSchema {
  return {
    type: "select",
    id: "channels",
    label: "Channels",
    help: "Mono halves the size of voice recordings. Auto keeps the source layout.",
    default: DEFAULT_CHANNELS,
    options: [
      { value: "auto", label: "Auto (keep source)" },
      { value: "1", label: "Mono" },
      { value: "2", label: "Stereo" },
    ],
  };
}

export function volumeControl(): ControlSchema {
  return {
    type: "range",
    id: "volume",
    label: "Volume",
    help: "Gain applied to the audio. 100% leaves it unchanged.",
    default: VOLUME_DEFAULT,
    min: VOLUME_MIN,
    max: VOLUME_MAX,
    step: 5,
    unit: "%",
  };
}

export function reverseControl(helpOverride?: string): ControlSchema {
  return {
    type: "checkbox",
    id: "reverse",
    label: "Reverse audio",
    help: helpOverride ?? "Play the audio backwards.",
    default: false,
  };
}

// Bitrate select. `defaultBitrate` lets a route preserve its historical default
// (the MP3/M4A converters shipped at a fixed 192k, so they pass "192k"); routes
// with no historical bitrate use the "auto" default.
export function bitrateControl(defaultBitrate: (typeof BITRATE_OPTIONS)[number] = "auto"): ControlSchema {
  return {
    type: "select",
    id: "bitrate",
    label: "Bitrate",
    help: "Higher bitrate keeps more detail but makes a larger file. With VBR on, this is the quality target.",
    default: defaultBitrate,
    options: [
      { value: "auto", label: "Auto (encoder default)" },
      { value: "320k", label: "320 kbps — best" },
      { value: "256k", label: "256 kbps" },
      { value: "192k", label: "192 kbps" },
      { value: "128k", label: "128 kbps" },
      { value: "96k", label: "96 kbps" },
      { value: "64k", label: "64 kbps" },
    ],
  };
}

export function vbrControl(): ControlSchema {
  return {
    type: "checkbox",
    id: "vbr",
    label: "Variable bitrate (VBR)",
    help: "Let the encoder vary the bitrate for better quality at a similar size. Uses the bitrate above as the quality target.",
    default: false,
  };
}

// Trim start/end as free-text timecode fields (SS, MM:SS, or HH:MM:SS). Blank =
// no trim on that end. Text inputs (not a visual time-range) so these work
// without a media preview, matching the converter routes' file-list UX.
export function trimControls(): ControlSchema[] {
  return [
    {
      type: "text",
      id: "trimStart",
      label: "Trim start",
      help: "Where to start, e.g. 0:15 or 90. Leave blank to start at the beginning.",
      default: "",
      placeholder: "0:00",
    },
    {
      type: "text",
      id: "trimEnd",
      label: "Trim end",
      help: "Where to stop, e.g. 1:30. Leave blank to keep to the end.",
      default: "",
      placeholder: "end",
    },
  ];
}

// Fade-in / fade-out lengths in seconds (0 = no fade).
export function fadeControls(): ControlSchema[] {
  return [
    {
      type: "number",
      id: "fadeIn",
      label: "Fade in",
      help: "Seconds to fade up from silence at the start. 0 = no fade.",
      default: FADE_DEFAULT,
      min: FADE_MIN,
      max: FADE_MAX,
      step: 1,
      unit: "s",
    },
    {
      type: "number",
      id: "fadeOut",
      label: "Fade out",
      help: "Seconds to fade down to silence at the end. 0 = no fade.",
      default: FADE_DEFAULT,
      min: FADE_MIN,
      max: FADE_MAX,
      step: 1,
      unit: "s",
    },
  ];
}
