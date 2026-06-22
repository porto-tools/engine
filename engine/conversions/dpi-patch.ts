// dpi-patch — pure, DOM-free byte-level writers that stamp a print resolution
// (DPI) into an already-encoded image's container metadata. Canvas / MozJPEG
// emit pixels but no DPI tag, so when the user asks for a specific DPI we patch
// the output blob's bytes AFTER encoding rather than re-encoding.
//
// Scope per container:
//   JPEG — set the JFIF APP0 density fields (unit = 1 = dots-per-inch, X/Y
//          density = the DPI, big-endian). canvas.toBlob and MozJPEG both emit a
//          JFIF APP0 as the first marker after SOI, so this is a fixed-offset
//          in-place patch with no length change.
//   PNG  — insert (or replace) a pHYs chunk right after IHDR. pHYs stores
//          pixels-per-UNIT with unit = 1 (metre), so DPI is converted to
//          pixels-per-metre = round(dpi * 39.3701). The chunk carries its own
//          CRC32 over [type + data] per the PNG spec.
//   WebP — no-op: there is no standard, widely-honoured DPI field in WebP, so we
//          deliberately leave the bytes untouched rather than write something a
//          viewer would ignore (or misread). The caller treats webp as unchanged.
//
// Everything here works on Uint8Array/ArrayBuffer only, so it is fully covered by
// the Node test suite (no canvas needed).
//
// NOTE on CRC32: the brief asked to reuse fflate's crc32, but fflate does not
// export a public crc32 (verified: it is an internal symbol in both the runtime
// and the .d.ts). To honour the HARD "no new deps" guardrail we implement the
// standard table-driven CRC32 (PNG/zlib polynomial 0xEDB88320) inline — it is a
// dozen lines and adds no dependency. Flagged for the orchestrator.

// 0 is the "unchanged" sentinel (byte-identical default); 1200 DPI is a generous
// print ceiling (most print workflows top out around 600).
export const MAX_DPI = 1200;
const MIN_DPI = 0;

// PNG pHYs stores pixels per metre; 1 inch = 0.0254 m, so 1 metre = 39.3701 inch.
const INCHES_PER_METRE = 39.3701;

// Clamp the DPI option to an integer in [0, MAX_DPI]. 0 (the default) means
// "leave the resolution unchanged". Non-numeric / missing values fall back to 0,
// so a bad option can never silently rewrite the resolution. Pure — unit-tested.
export function clampDpi(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(n)));
}

// Standard table-driven CRC32 (polynomial 0xEDB88320), the variant the PNG spec
// mandates for chunk CRCs. The table is built once and memoised.
let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Patch a JPEG's JFIF APP0 density fields in place. Returns the SAME bytes
// (mutated) when a JFIF APP0 is present, or the unchanged input when it is not
// (e.g. an EXIF-only JPEG with no JFIF marker — rare from Canvas/MozJPEG, but we
// never want to corrupt a segment we don't recognise).
//
// JFIF APP0 layout (offsets from the file start, since APP0 is the first marker
// after the 2-byte SOI):
//   0-1   SOI            FF D8
//   2-3   APP0 marker    FF E0
//   4-5   segment length (big-endian, includes these 2 length bytes)
//   6-10  identifier     "JFIF\0"
//   11-12 version        major, minor
//   13    density units  0 = none, 1 = dpi, 2 = dots/cm  ← set to 1
//   14-15 X density      big-endian                       ← set to dpi
//   16-17 Y density      big-endian                       ← set to dpi
export function patchJfifDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  // Must start with SOI then an APP0 marker carrying the "JFIF\0" identifier.
  if (bytes.length < 18) return bytes;
  const hasSoi = bytes[0] === 0xff && bytes[1] === 0xd8;
  const hasApp0 = bytes[2] === 0xff && bytes[3] === 0xe0;
  const isJfif =
    bytes[6] === 0x4a && // J
    bytes[7] === 0x46 && // F
    bytes[8] === 0x49 && // I
    bytes[9] === 0x46 && // F
    bytes[10] === 0x00; // \0
  if (!hasSoi || !hasApp0 || !isJfif) return bytes;

  bytes[13] = 1; // density unit = dots-per-inch
  bytes[14] = (dpi >> 8) & 0xff; // X density high byte
  bytes[15] = dpi & 0xff; // X density low byte
  bytes[16] = (dpi >> 8) & 0xff; // Y density high byte
  bytes[17] = dpi & 0xff; // Y density low byte
  return bytes;
}

// The PNG 8-byte signature.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// "IHDR" and "pHYs" chunk-type bytes.
const IHDR = [0x49, 0x48, 0x44, 0x52];
const PHYS = [0x70, 0x48, 0x59, 0x73];

function matchesAt(bytes: Uint8Array, offset: number, pattern: number[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeU32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

// Build a complete pHYs chunk (length + type + 9-byte data + CRC) for the given
// pixels-per-unit. unit = 1 means "metre", which is the only standard pHYs unit.
function buildPhysChunk(ppu: number): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + 9 + 4); // length + type + data + crc
  writeU32BE(chunk, 0, 9); // data length = 9
  chunk.set(PHYS, 4); // type "pHYs"
  writeU32BE(chunk, 8, ppu); // X pixels per unit
  writeU32BE(chunk, 12, ppu); // Y pixels per unit
  chunk[16] = 1; // unit specifier = metre
  // CRC covers the chunk type + data (bytes 4 .. 17), per the PNG spec.
  const crc = crc32(chunk.subarray(4, 17));
  writeU32BE(chunk, 17, crc);
  return chunk;
}

// Insert or replace a PNG pHYs chunk so the image declares the requested DPI.
// Returns NEW bytes (the file grows or, when replacing, stays the same size).
// Returns the unchanged input when the bytes are not a PNG with an IHDR first
// chunk — we never want to corrupt an unrecognised stream.
//
// pHYs must appear before the first IDAT and after IHDR; placing it immediately
// after IHDR satisfies the spec for every encoder we emit.
export function patchPngPhys(bytes: Uint8Array, dpi: number): Uint8Array {
  // Validate signature + that the first chunk is IHDR (type at offset 12).
  if (bytes.length < 8 + 12) return bytes;
  if (!matchesAt(bytes, 0, PNG_SIGNATURE)) return bytes;
  if (!matchesAt(bytes, 12, IHDR)) return bytes;

  // IHDR data length lives at offset 8; the IHDR chunk spans length(4) +
  // type(4) + data + crc(4). The pHYs insertion point is right after IHDR.
  const ihdrDataLen = readU32BE(bytes, 8);
  const insertAt = 8 + 4 + 4 + ihdrDataLen + 4; // past IHDR's CRC

  const ppu = Math.round(dpi * INCHES_PER_METRE);
  const physChunk = buildPhysChunk(ppu);

  // If a pHYs chunk already sits at the insertion point (e.g. we are re-patching
  // our own output), overwrite it in place instead of inserting a duplicate.
  if (matchesAt(bytes, insertAt + 4, PHYS)) {
    const existingDataLen = readU32BE(bytes, insertAt);
    const existingChunkLen = 4 + 4 + existingDataLen + 4;
    const out = new Uint8Array(bytes.length - existingChunkLen + physChunk.length);
    out.set(bytes.subarray(0, insertAt), 0);
    out.set(physChunk, insertAt);
    out.set(bytes.subarray(insertAt + existingChunkLen), insertAt + physChunk.length);
    return out;
  }

  const out = new Uint8Array(bytes.length + physChunk.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(physChunk, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + physChunk.length);
  return out;
}

// Convenience for the conversion pipelines: take an encoded output Blob and,
// when a positive DPI is requested, return a NEW Blob with the DPI stamped into
// the container that matches `mime`. JPEG → JFIF, PNG → pHYs, WebP (and anything
// else) → unchanged (returned as-is). A dpi of 0 short-circuits to the original
// blob, so the default path is byte-identical. Async because reading the blob's
// bytes is async.
export async function applyDpiToBlob(blob: Blob, mime: string, dpi: number): Promise<Blob> {
  if (dpi <= 0) return blob;
  const original = new Uint8Array(await blob.arrayBuffer());
  // Wrap in a fresh ArrayBuffer-backed view so the Blob() BlobPart type is
  // ArrayBuffer (the patch helpers return the loose Uint8Array<ArrayBufferLike>).
  if (mime === "image/jpeg") {
    return new Blob([new Uint8Array(patchJfifDpi(original, dpi))], { type: mime });
  }
  if (mime === "image/png") {
    return new Blob([new Uint8Array(patchPngPhys(original, dpi))], { type: mime });
  }
  // WebP and any other container: no standard DPI mechanism — leave untouched.
  return blob;
}
