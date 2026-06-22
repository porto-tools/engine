import { describe, it, expect } from "vitest";
import {
  buildAudioArgs,
  parseTimecode,
  type AudioCodec,
} from "./audio-settings";

// The shared audio-settings module is fully pure and Node-testable — no FFmpeg
// runtime, no Worker, no blob: URLs. This suite is the quality lever for the
// whole audio group: every route delegates its arg assembly to buildAudioArgs,
// so proving the builder here covers the four converters + extract-audio at once.

// Codec descriptors matching the real routes.
const MP3: AudioCodec = { lossy: true, ffmpegArgs: ["-c:a", "libmp3lame"], vbrEncoder: "libmp3lame" };
const AAC: AudioCodec = { lossy: true, ffmpegArgs: ["-c:a", "aac"], vbrEncoder: "aac" };
const WAV: AudioCodec = { lossy: false };

describe("parseTimecode", () => {
  it("parses bare seconds (may exceed 60)", () => {
    expect(parseTimecode("0")).toBe(0);
    expect(parseTimecode("15")).toBe(15);
    expect(parseTimecode("90")).toBe(90); // 90 plain seconds is valid
    expect(parseTimecode("90.25")).toBe(90.25);
  });

  it("parses MM:SS", () => {
    expect(parseTimecode("1:30")).toBe(90);
    expect(parseTimecode("0:15")).toBe(15);
    expect(parseTimecode("10:00")).toBe(600);
  });

  it("parses HH:MM:SS with optional milliseconds", () => {
    expect(parseTimecode("1:00:00")).toBe(3600);
    expect(parseTimecode("0:01:30")).toBe(90);
    expect(parseTimecode("1:02:03.5")).toBe(3723.5);
  });

  it("leaves the hours field unbounded (a long timecode is valid)", () => {
    expect(parseTimecode("99:00:00")).toBe(356400);
  });

  it("rejects garbage, empty, and out-of-range fields", () => {
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode("   ")).toBeNull();
    expect(parseTimecode("abc")).toBeNull();
    expect(parseTimecode("1:2:3:4")).toBeNull(); // too many parts
    expect(parseTimecode("1:90")).toBeNull(); // seconds ≥ 60 in MM:SS form
    expect(parseTimecode("1:99:00")).toBeNull(); // minutes ≥ 60 in HH:MM:SS form
    expect(parseTimecode("-5")).toBeNull(); // negative
    expect(parseTimecode("1:.5")).toBeNull(); // empty seconds field
    expect(parseTimecode(42)).toBeNull(); // non-string
    expect(parseTimecode(undefined)).toBeNull();
  });
});

describe("buildAudioArgs — defaults emit the original minimal args", () => {
  it("WAV (lossless): bare remux, no codec flag, no bitrate", () => {
    expect(buildAudioArgs({ inName: "input.mp3", outName: "output.wav", codec: WAV })).toEqual([
      "-i", "input.mp3", "output.wav",
    ]);
  });

  it("MP3 (lossy) at the route default 192k: -c:a + -b:a 192k", () => {
    expect(
      buildAudioArgs({
        inName: "input.wav",
        outName: "output.mp3",
        codec: MP3,
        options: { bitrate: "192k" },
      }),
    ).toEqual(["-i", "input.wav", "-c:a", "libmp3lame", "-b:a", "192k", "output.mp3"]);
  });

  it("M4A (lossy) at the route default 192k: -c:a aac + -b:a 192k", () => {
    expect(
      buildAudioArgs({
        inName: "input.mp3",
        outName: "output.m4a",
        codec: AAC,
        options: { bitrate: "192k" },
      }),
    ).toEqual(["-i", "input.mp3", "-c:a", "aac", "-b:a", "192k", "output.m4a"]);
  });

  it("extract-audio default (bitrate auto): -vn + codec, no -b:a", () => {
    expect(
      buildAudioArgs({
        inName: "input.mp4",
        outName: "output.mp3",
        codec: MP3,
        preCodecArgs: ["-vn"],
        options: { bitrate: "auto" },
      }),
    ).toEqual(["-i", "input.mp4", "-vn", "-c:a", "libmp3lame", "output.mp3"]);
  });
});

describe("buildAudioArgs — bitrate (CBR)", () => {
  it("emits -b:a only for lossy + only when ≠ auto + only when vbr off", () => {
    // ≠ auto, vbr off → -b:a emitted
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: MP3, options: { bitrate: "320k" } }),
    ).toEqual(["-i", "i", "-c:a", "libmp3lame", "-b:a", "320k", "o"]);
    // auto → no -b:a
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: MP3, options: { bitrate: "auto" } }),
    ).toEqual(["-i", "i", "-c:a", "libmp3lame", "o"]);
  });

  it("NEVER emits bitrate for a lossless (WAV) codec, even when set", () => {
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: WAV,
        options: { bitrate: "320k", vbr: true },
      }),
    ).toEqual(["-i", "i", "o"]);
  });

  it("falls back to auto (no flag) on an invalid bitrate value", () => {
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: MP3, options: { bitrate: "999k" } }),
    ).toEqual(["-i", "i", "-c:a", "libmp3lame", "o"]);
  });
});

describe("buildAudioArgs — VBR maps to the right per-codec quality flag", () => {
  it("libmp3lame VBR emits -q:a on the LAME -V scale (lower = better)", () => {
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: MP3,
        options: { bitrate: "320k", vbr: true },
      }),
    ).toEqual(["-i", "i", "-c:a", "libmp3lame", "-q:a", "0", "o"]);
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: MP3,
        options: { bitrate: "128k", vbr: true },
      }),
    ).toEqual(["-i", "i", "-c:a", "libmp3lame", "-q:a", "4", "o"]);
  });

  it("native aac VBR emits -q:a per-stream quality (higher = better)", () => {
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: AAC,
        options: { bitrate: "320k", vbr: true },
      }),
    ).toEqual(["-i", "i", "-c:a", "aac", "-q:a", "2", "o"]);
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: AAC,
        options: { bitrate: "64k", vbr: true },
      }),
    ).toEqual(["-i", "i", "-c:a", "aac", "-q:a", "0.5", "o"]);
  });

  it("VBR on with bitrate auto has no target to map → emits neither -b:a nor -q:a", () => {
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: MP3,
        options: { bitrate: "auto", vbr: true },
      }),
    ).toEqual(["-i", "i", "-c:a", "libmp3lame", "o"]);
  });
});

describe("buildAudioArgs — trim is emitted as atrim INSIDE the filter chain (NOT -ss/-to)", () => {
  // Regression guard for the trim+fade BLOCKER: trim used to be output-side
  // -ss/-to, which left the areverse-based fade-out operating on the full
  // decoded stream. Trim now leads the single -filter:a as atrim+asetpts.

  it("start-only → atrim=start=<s>,asetpts as the LEADING filters; no -ss/-to", () => {
    const args = buildAudioArgs({
      inName: "i", outName: "o", codec: WAV, options: { trimStart: "0:15" },
    });
    expect(args).toEqual([
      "-i", "i", "-filter:a", "atrim=start=15,asetpts=N/SR/TB", "o",
    ]);
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-to");
  });

  it("end-only → atrim=end=<e>,asetpts; no -ss/-to", () => {
    const args = buildAudioArgs({
      inName: "i", outName: "o", codec: WAV, options: { trimEnd: "1:30" },
    });
    expect(args).toEqual([
      "-i", "i", "-filter:a", "atrim=end=90,asetpts=N/SR/TB", "o",
    ]);
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-to");
  });

  it("both bounds → atrim=start=<s>:end=<e>,asetpts as the LEADING filters", () => {
    const args = buildAudioArgs({
      inName: "i",
      outName: "o",
      codec: MP3,
      options: { bitrate: "192k", trimStart: "10", trimEnd: "20", volume: 150 },
    });
    expect(args).toEqual([
      "-i", "i", "-c:a", "libmp3lame",
      "-filter:a", "atrim=start=10:end=20,asetpts=N/SR/TB,volume=1.5",
      "-b:a", "192k", "o",
    ]);
    // The atrim must come first in the chain, before any other filter.
    const chain = args[args.indexOf("-filter:a") + 1];
    expect(chain.startsWith("atrim=start=10:end=20,asetpts=N/SR/TB")).toBe(true);
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-to");
  });

  it("ignores an unparseable trim value (no atrim, no -ss/-to)", () => {
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: WAV, options: { trimStart: "abc" } }),
    ).toEqual(["-i", "i", "o"]);
  });
});

describe("buildAudioArgs — trim composes correctly with fade (the BLOCKER regression)", () => {
  // The whole point: with trim leading the chain, the fade-out reverse trick
  // operates on the TRIMMED segment, so the fade lands at the trimmed end.

  it("trim + fadeOut: atrim precedes the afade so the fade is INSIDE the trimmed segment", () => {
    const args = buildAudioArgs({
      inName: "i", outName: "o", codec: WAV, options: { trimStart: "10", trimEnd: "30", fadeOut: 5 },
    });
    expect(args).toEqual([
      "-i", "i",
      "-filter:a",
      "atrim=start=10:end=30,asetpts=N/SR/TB,areverse,afade=t=in:st=0:d=5,areverse",
      "o",
    ]);
    const chain = args[args.indexOf("-filter:a") + 1];
    // atrim is positioned strictly before the fade in the single filter string.
    expect(chain.indexOf("atrim=")).toBeLessThan(chain.indexOf("afade=t=in"));
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-to");
  });

  it("trim + fadeIn: atrim precedes afade=t=in", () => {
    const args = buildAudioArgs({
      inName: "i", outName: "o", codec: WAV, options: { trimStart: "10", fadeIn: 3 },
    });
    expect(args).toEqual([
      "-i", "i",
      "-filter:a", "atrim=start=10,asetpts=N/SR/TB,afade=t=in:st=0:d=3",
      "o",
    ]);
    const chain = args[args.indexOf("-filter:a") + 1];
    expect(chain.indexOf("atrim=")).toBeLessThan(chain.indexOf("afade=t=in"));
  });

  it("reverse + fadeOut (no trim): areverse(user) then the reverse-trick fade-out", () => {
    // Documented expected chain: the user's areverse plays the clip backwards,
    // then the reverse-trick (areverse,afade,areverse) fades the END of that
    // reversed playback. No trim ⇒ no atrim.
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: WAV, options: { reverse: true, fadeOut: 4 } }),
    ).toEqual([
      "-i", "i",
      "-filter:a", "areverse,areverse,afade=t=in:st=0:d=4,areverse",
      "o",
    ]);
  });

  it("reverse + fadeOut + trim together: atrim leads, then the reverse/fade composition", () => {
    const args = buildAudioArgs({
      inName: "i",
      outName: "o",
      codec: MP3,
      options: { bitrate: "192k", reverse: true, fadeOut: 4, trimStart: "10", trimEnd: "30" },
    });
    expect(args).toEqual([
      "-i", "i", "-c:a", "libmp3lame",
      "-filter:a",
      "atrim=start=10:end=30,asetpts=N/SR/TB,areverse,areverse,afade=t=in:st=0:d=4,areverse",
      "-b:a", "192k", "o",
    ]);
    const chain = args[args.indexOf("-filter:a") + 1];
    // atrim+asetpts strictly precede everything (the reverse/fade composition),
    // so the whole composition runs on the trimmed segment.
    expect(chain.startsWith("atrim=start=10:end=30,asetpts=N/SR/TB,")).toBe(true);
    expect(chain.indexOf("atrim=")).toBeLessThan(chain.indexOf("areverse"));
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-to");
  });
});

describe("buildAudioArgs — fade arg shape", () => {
  it("fade-in is afade=t=in:st=0:d=<n>", () => {
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: WAV, options: { fadeIn: 3 } }),
    ).toEqual(["-i", "i", "-filter:a", "afade=t=in:st=0:d=3", "o"]);
  });

  it("fade-out uses the reverse trick (no duration probe needed)", () => {
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: WAV, options: { fadeOut: 5 } }),
    ).toEqual([
      "-i", "i",
      "-filter:a", "areverse,afade=t=in:st=0:d=5,areverse",
      "o",
    ]);
  });

  it("0-second fades emit nothing", () => {
    expect(
      buildAudioArgs({ inName: "i", outName: "o", codec: WAV, options: { fadeIn: 0, fadeOut: 0 } }),
    ).toEqual(["-i", "i", "o"]);
  });
});

describe("buildAudioArgs — filter-chain ordering", () => {
  it("orders areverse → volume → fade-in → fade-out in ONE -filter:a", () => {
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: WAV,
        options: { reverse: true, volume: 150, fadeIn: 2, fadeOut: 4 },
      }),
    ).toEqual([
      "-i", "i",
      "-filter:a",
      "areverse,volume=1.5,afade=t=in:st=0:d=2,areverse,afade=t=in:st=0:d=4,areverse",
      "o",
    ]);
  });

  it("full segment order: codec → filters (trim leads) → bitrate → -ar → -ac → out", () => {
    expect(
      buildAudioArgs({
        inName: "i",
        outName: "o",
        codec: MP3,
        options: {
          bitrate: "256k",
          trimStart: "5",
          trimEnd: "30",
          volume: 50,
          sampleRate: "44100",
          channels: "1",
        },
      }),
    ).toEqual([
      "-i", "i", "-c:a", "libmp3lame",
      "-filter:a", "atrim=start=5:end=30,asetpts=N/SR/TB,volume=0.5",
      "-b:a", "256k",
      "-ar", "44100",
      "-ac", "1",
      "o",
    ]);
  });
});
