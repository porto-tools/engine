// Shared FFmpeg.wasm loader — the single place every audio/video conversion goes
// to obtain a loaded FFmpeg instance. Two cores exist (decision 0009):
//
//   "st" — single-threaded, served from /ffmpeg-st/. Used by audio routes
//          (MP3/WAV/M4A). No SharedArrayBuffer, so no COOP/COEP headers are
//          needed and AdSense survives on those pages.
//   "mt" — multi-threaded, served from /ffmpeg-mt/. Used by video routes
//          (MP4/GIF/WEBM). Needs crossOriginIsolated (SharedArrayBuffer), which
//          the four video routes get via public/_headers.
//
// Caching model: one FFmpeg instance per mode, created at most once. Concurrent
// callers share a single in-flight load promise (the promise-ref pattern) so a
// second convert that starts while the first is still loading does not kick off
// a duplicate ffmpeg.load() — they both await the same promise and then reuse the
// same instance. A failed load clears the cached promise so a later retry can
// try again from scratch (load is recoverable).
//
// Engine firewall: this file imports ONLY @ffmpeg/* (node_modules) and the
// sibling types module. It never reaches into app/components/lib. See types.ts.

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { ConversionError } from "../types";

export type FFmpegMode = "st" | "mt";

// Where each core's three/two files live under public/. The fetch script
// (scripts/fetch-ffmpeg-cores.mjs) writes exactly these paths.
const CORE_DIR: Record<FFmpegMode, string> = {
  st: "/ffmpeg-st",
  mt: "/ffmpeg-mt",
};

const MIME_JS = "text/javascript";
const MIME_WASM = "application/wasm";

// Per-mode singletons. `instances` holds the fully-loaded FFmpeg; `loadPromises`
// holds the in-flight (or settled) load promise so concurrent callers coalesce.
const instances: Partial<Record<FFmpegMode, FFmpeg>> = {};
const loadPromises: Partial<Record<FFmpegMode, Promise<FFmpeg>>> = {};

// Drop a (now-terminated) instance from the cache so the next loadFFmpeg builds a
// fresh one. Used by the abort path in runFFmpeg, which terminates the worker.
function evictInstance(ffmpeg: FFmpeg): void {
  (Object.keys(instances) as FFmpegMode[]).forEach((m) => {
    if (instances[m] === ffmpeg) {
      delete instances[m];
      delete loadPromises[m];
    }
  });
}

// ── Cross-tab serialization for heavy MT (video) work ───────────────────────────
// One ffmpeg video conversion pre-spawns a large pthread pool and uses essentially
// the whole CPU. Without coordination, a SECOND video conversion in another tab
// fights it for the CPU — that second tab's engine setup is starved and looks frozen
// until the first finishes. We take a same-origin Web Lock so video work serializes
// across tabs: a second tab simply waits (showing the normal "setting up" state) and
// then runs at full speed the moment the first releases. Audio (ST) is light and is
// never locked. Degrades to a no-op where the Web Locks API is unavailable.
const VIDEO_LOCK = "porto-ffmpeg-mt";

function lockManager(): LockManager | undefined {
  return typeof navigator !== "undefined" ? navigator.locks : undefined;
}

// Resolve once no other tab holds the video lock (acquire-then-immediately-release).
// Called before spawning the MT core's pthread pool so setup doesn't fight a running
// conversion for the CPU.
async function awaitVideoLockFree(): Promise<void> {
  const locks = lockManager();
  if (!locks) return;
  try {
    await locks.request(VIDEO_LOCK, async () => undefined);
  } catch {
    /* lock unavailable — proceed unserialized */
  }
}

// Build the blob-URL'd load config for a mode. Cores are self-hosted in public/
// and turned into blob: URLs via toBlobURL — same-origin fetch, no CDN, matching
// the on-device privacy promise (decision 0009 §4).
async function buildLoadConfig(
  mode: FFmpegMode,
  toBlobURL: (url: string, mimeType: string) => Promise<string>,
): Promise<{ coreURL: string; wasmURL: string; workerURL?: string }> {
  const dir = CORE_DIR[mode];
  const coreURL = await toBlobURL(`${dir}/ffmpeg-core.js`, MIME_JS);
  const wasmURL = await toBlobURL(`${dir}/ffmpeg-core.wasm`, MIME_WASM);
  if (mode === "mt") {
    // The MT core additionally needs its pthread worker. The ST core has none.
    const workerURL = await toBlobURL(`${dir}/ffmpeg-core.worker.js`, MIME_JS);
    return { coreURL, wasmURL, workerURL };
  }
  return { coreURL, wasmURL };
}

async function createAndLoad(mode: FFmpegMode): Promise<FFmpeg> {
  // Lazy import so the @ffmpeg/* code lands only in the route chunks that use it,
  // never in the homepage/shared bundle (mirrors heic-jpg's loadEngine).
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const { toBlobURL } = await import("@ffmpeg/util");

  // `mode` here is already the RESOLVED mode (see resolveMode in loadFFmpeg): a
  // caller's "mt" request is downgraded to "st" before reaching this point
  // whenever the page is not cross-origin isolated, so the MT core (which needs
  // SharedArrayBuffer) is only ever loaded when SharedArrayBuffer truly exists.
  const ffmpeg = new FFmpeg();
  const config = await buildLoadConfig(mode, toBlobURL);
  // classWorkerURL is intentionally omitted: the @ffmpeg/ffmpeg class worker is
  // resolved by the bundler from `new URL("./worker.js", import.meta.url)` inside
  // the library and emitted as a chunk. We only supply the CORE urls.
  // Don't spawn the MT core's pthread pool while another tab is mid-conversion — that
  // starves this tab's setup until the other finishes (it looks frozen). Wait for the
  // cross-tab video lock to be free first; the next conversion will load instantly.
  if (mode === "mt") await awaitVideoLockFree();
  await ffmpeg.load(config);
  return ffmpeg;
}

// Whether the single-threaded fallback has already been logged (log once total,
// not once per conversion).
let warnedAboutFallback = false;

// Resolve the REQUESTED core mode to the one we can actually run here. The MT core
// needs SharedArrayBuffer, which only exists on a cross-origin-isolated page. When
// the page is not isolated (the dev server, or any host without COOP/COEP) we
// transparently downgrade "mt" → "st": the SAME LGPL ffmpeg build (decision 0009),
// same codecs, just single-threaded and slower. Cross-origin-isolated production
// video routes (public/_headers) still get the fast MT core. Net effect: video and
// GIF tools work everywhere instead of throwing a cross-origin-isolation error.
function resolveMode(mode: FFmpegMode): FFmpegMode {
  if (
    mode === "mt" &&
    typeof globalThis.crossOriginIsolated !== "undefined" &&
    !globalThis.crossOriginIsolated
  ) {
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      console.info(
        "[ffmpeg] Page is not cross-origin isolated — using the single-threaded core " +
          "(slower). Production video routes are isolated via public/_headers and use " +
          "the faster multi-threaded core.",
      );
    }
    return "st";
  }
  return mode;
}

/**
 * Load (or reuse) the cached FFmpeg instance for a core mode.
 *
 * - The requested mode is first resolved (mt → st when not cross-origin isolated).
 * - First call for a (resolved) mode starts the load and caches the promise.
 * - Concurrent callers share that same in-flight promise (no double-load).
 * - After it resolves, subsequent calls return the cached instance immediately.
 * - On failure the cached promise is cleared so a retry can start fresh, and the
 *   error is normalised to a recoverable ENGINE_LOAD_FAILED ConversionError.
 */
export async function loadFFmpeg(requestedMode: FFmpegMode): Promise<FFmpeg> {
  const mode = resolveMode(requestedMode);
  const ready = instances[mode];
  if (ready) return ready;

  const inFlight = loadPromises[mode];
  if (inFlight) return inFlight;

  const promise = createAndLoad(mode)
    .then((ffmpeg) => {
      instances[mode] = ffmpeg;
      return ffmpeg;
    })
    .catch((err) => {
      // Drop the failed promise so the next call retries instead of re-awaiting
      // a rejected promise forever.
      delete loadPromises[mode];
      if (err instanceof ConversionError) throw err;
      throw new ConversionError("Failed to load the audio/video engine.", {
        code: "ENGINE_LOAD_FAILED",
        recoverable: true,
        technical: err instanceof Error ? err.message : String(err),
      });
    });

  loadPromises[mode] = promise;
  return promise;
}

/**
 * Convenience wrapper around the write → exec → read cycle that every FFmpeg
 * conversion shares. Writes `input` to `inName`, runs ffmpeg with `args`, reads
 * `outName` back, and returns the raw bytes. Cleans up both virtual-FS files in
 * a finally so repeated conversions don't accumulate files in the MEMFS.
 *
 * `args` are passed verbatim to ffmpeg.exec — the caller owns the full command
 * (including referencing `inName`/`outName`). A non-zero exit is surfaced by the
 * caller's own error handling (exec resolves with the exit code; readFile of a
 * never-written output will reject, which the caller maps to DECODE_FAILED).
 *
 * Ownership note: @ffmpeg/ffmpeg's writeFile TRANSFERS the Uint8Array's backing
 * ArrayBuffer to the worker (it pushes `data.buffer` into postMessage's transfer
 * list), which DETACHES that buffer in this thread. If the caller reuses the same
 * Uint8Array for a second call (e.g. a probe pass then the real pass, or a retry
 * after the mt→st fallback), the second writeFile would throw "ArrayBuffer at
 * index 0 is already detached". To make every call self-contained we hand
 * writeFile a fresh, exclusively-owned copy of the bytes each time, so detaching
 * it never affects the caller's buffer or any later attempt. `new Uint8Array(input)`
 * copies into a brand-new exactly-sized ArrayBuffer (byteOffset 0), so even an
 * `input` that is a view onto a larger shared buffer is isolated here.
 */
export async function runFFmpeg(
  ffmpeg: FFmpeg,
  opts: {
    inName: string;
    outName: string;
    input: Uint8Array;
    args: string[];
    signal?: AbortSignal;
  },
): Promise<{ data: Uint8Array; exitCode: number }> {
  // Serialize heavy MT (video) work across tabs: hold the video lock for the whole
  // write → exec → read cycle so a concurrent conversion in another tab queues
  // instead of thrashing the CPU. Audio (ST) runs immediately. An abort while waiting
  // for the lock rejects via the signal and is surfaced as CANCELLED by the caller.
  const locks = lockManager();
  if (instances.mt === ffmpeg && locks) {
    const result: { data: Uint8Array; exitCode: number } = await locks.request(
      VIDEO_LOCK,
      { signal: opts.signal },
      () => runFFmpegBody(ffmpeg, opts),
    );
    return result;
  }
  return runFFmpegBody(ffmpeg, opts);
}

async function runFFmpegBody(
  ffmpeg: FFmpeg,
  opts: {
    inName: string;
    outName: string;
    input: Uint8Array;
    args: string[];
    signal?: AbortSignal;
  },
): Promise<{ data: Uint8Array; exitCode: number }> {
  const { inName, outName, input, args, signal } = opts;
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
  // Fresh owned copy per attempt — writeFile detaches the buffer it is given.
  const ownedInput = new Uint8Array(input);

  // Real cancellation: ffmpeg.wasm can't interrupt a running exec from JS, so the
  // only way to actually stop it is to TERMINATE the worker. On abort we terminate
  // this instance and evict it from the cache so the next conversion loads a fresh
  // one. (We still pass the signal to the ffmpeg calls so the pending promise also
  // rejects immediately for a snappy UI.)
  let terminated = false;
  const onAbort = () => {
    terminated = true;
    try {
      ffmpeg.terminate();
    } catch {
      /* worker already gone */
    }
    evictInstance(ffmpeg);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await ffmpeg.writeFile(inName, ownedInput, signal ? { signal } : undefined);
    const exitCode = await ffmpeg.exec(args, undefined, signal ? { signal } : undefined);
    const data = await ffmpeg.readFile(outName, undefined, signal ? { signal } : undefined);
    // readFile can return a string when an encoding is requested; we never pass
    // one, so the result is always Uint8Array. Normalise the type for callers.
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return { data: bytes, exitCode };
  } catch (err) {
    // A terminate (or any abort) surfaces here as a rejected ffmpeg call.
    if (terminated || signal?.aborted) {
      throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Skip the virtual-FS cleanup when terminated — the worker (and its MEMFS) is
    // already gone, and calling into a dead instance would hang.
    if (!terminated) {
      try {
        await ffmpeg.deleteFile(inName);
      } catch {
        /* ignore */
      }
      try {
        await ffmpeg.deleteFile(outName);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Video metadata + bitrate policy (shared by the video tools)
// ---------------------------------------------------------------------------

/**
 * Probe a video File's duration (seconds) via a hidden <video> element, used to
 * derive a sensible re-encode bitrate (below). Resolves to 0 if the browser can't
 * read the metadata, so callers fall back to a default bitrate rather than failing.
 */
export function probeVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(0);
      return;
    }
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (seconds: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => done(video.duration);
    video.onerror = () => done(0);
    video.src = url;
  });
}

/**
 * Recommend a video bitrate (bits/sec) for a re-encode that PRESERVES the source's
 * quality budget. Re-encoding through a filter (speed, reverse, crop…) forces a
 * re-encode; without an explicit bitrate the openh264 core falls back to a very low
 * default that collapses quality (a crisp 720p clip comes out looking like 180p).
 * Targeting the source's own average bitrate (fileSize*8/duration) keeps the input's
 * fidelity, clamped to a sane floor/ceiling. Falls back to 4 Mbps if duration is 0.
 */
export function recommendedVideoBitrate(fileSizeBytes: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 4_000_000;
  const sourceBitsPerSec = (fileSizeBytes * 8) / durationSeconds;
  // Give the whole source budget to video (audio is small; a little extra video
  // bitrate never hurts). Clamp to 0.6–20 Mbps.
  return Math.round(Math.min(20_000_000, Math.max(600_000, sourceBitsPerSec)));
}
