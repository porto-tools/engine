// page-ranges — the shared, Microsoft-print-style page-range core. Pure: no DOM,
// no engine import. Several features build on it (Rotate, Delete, Reorder,
// PDF-to-image), so the grammar here is the single source of truth for how a
// human types "which pages".
//
// Grammar (mirrors validatePageRange in lib/controls.ts):
//   - a comma-separated list of PARTS
//   - each part is either a single page "5" or an inclusive range "8-10"
//   - pages are 1-based; bounds are checked against pageCount when it is known
// The difference from validatePageRange is that THIS module RETURNS the pages,
// not just a yes/no — so the same typed string can drive a selection, a deletion,
// or a reorder.
//
// Two reading modes:
//   - parsePageList  → a SORTED, UNIQUE set (order of typing is irrelevant)
//   - parseOrderList → ORDER-PRESERVING, each page at most once (typing order is
//     the output order; appendMissing then covers any omitted page)
//
// The calm one-line messages match the tone and wording of validatePageRange so
// the inline UI reads the same everywhere.

// Result of parsing a string into a page SET. `valid` gates a Convert button;
// `message` (when present) is the calm one-line warning shown under the field.
// `pages` is sorted ascending, unique, 1-based. An empty input is valid with an
// empty `pages` — the CALLER decides what "no pages typed" means (often "all").
export interface PageListResult {
  pages: number[];
  valid: boolean;
  message?: string;
}

// Result of parsing a string into an ORDERED page list (typing order preserved,
// each page at most once). Shape mirrors PageListResult but the field is `order`.
export interface OrderListResult {
  order: number[];
  valid: boolean;
  message?: string;
}

// A contiguous run of pages, inclusive on both ends (start <= end). The compact
// form of a sorted page set: [1,2,3,4,6] → [{1,4},{6,6}].
export interface PageRange {
  start: number;
  end: number;
}

// True when pageCount is a usable upper bound (a finite integer >= 1). When it is
// not known the parsers check SHAPE only, never bounds — same as validatePageRange.
function hasBound(pageCount: number | undefined): pageCount is number {
  return typeof pageCount === "number" && Number.isFinite(pageCount) && pageCount >= 1;
}

// Split on commas into trimmed, non-empty parts. Mirrors validatePageRange's
// tolerance for stray whitespace and empty segments ("1, ,3" → ["1","3"]).
function splitParts(input: string): string[] {
  const parts: string[] = [];
  for (const raw of input.split(",")) {
    const part = raw.trim();
    if (part !== "") parts.push(part);
  }
  return parts;
}

// What one part of the list expands to: a single page, an inclusive range, or a
// problem (with the part text the message points at). Kept internal — callers see
// only the assembled PageListResult / OrderListResult.
type ParsedPart =
  | { ok: true; pages: number[] }
  | { ok: false; message: string };

// Parse and bounds-check a single part against the same grammar as
// validatePageRange. A range expands inclusively; when start > end it expands
// DESCENDING (so order mode can express a reverse run like "3-1"). For the sorted
// set this direction is irrelevant — the caller re-sorts — but keeping the
// natural order here is what makes parseOrderList useful for reordering.
function parsePart(part: string, pageCount: number | undefined): ParsedPart {
  const known = hasBound(pageCount);
  const dash = part.indexOf("-");

  if (dash === -1) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, message: `"${part}" isn't a valid page number.` };
    }
    if (known && n > pageCount) {
      return { ok: false, message: `This document has ${pageCount} pages — ${n} is out of range.` };
    }
    return { ok: true, pages: [n] };
  }

  const a = Number(part.slice(0, dash).trim());
  const b = Number(part.slice(dash + 1).trim());
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
    return { ok: false, message: `"${part}" isn't a valid page range.` };
  }
  if (known && (a > pageCount || b > pageCount)) {
    return { ok: false, message: `This document has ${pageCount} pages — ${part} is out of range.` };
  }

  const pages: number[] = [];
  if (a <= b) {
    for (let p = a; p <= b; p++) pages.push(p);
  } else {
    for (let p = a; p >= b; p--) pages.push(p);
  }
  return { ok: true, pages };
}

// Parse a string like "1,3,6-8" or "5-10" into a SORTED, UNIQUE, 1-based array.
//   - empty/whitespace-only input → { pages: [], valid: true } (caller decides
//     what an empty selection means, e.g. "all pages")
//   - any malformed or out-of-range part → { valid: false, message } (the FIRST
//     problem, in the calm tone of validatePageRange)
export function parsePageList(input: string, pageCount?: number): PageListResult {
  const parts = splitParts(input);
  if (parts.length === 0) {
    return { pages: [], valid: true };
  }

  const seen = new Set<number>();
  for (const part of parts) {
    const parsed = parsePart(part, pageCount);
    if (!parsed.ok) {
      return { pages: [], valid: false, message: parsed.message };
    }
    for (const p of parsed.pages) seen.add(p);
  }

  const pages = Array.from(seen).sort((x, y) => x - y);
  return { pages, valid: true };
}

// Parse a string with the SAME grammar as parsePageList but ORDER-PRESERVING:
// the output keeps the order the pages were typed, and each page appears at most
// once (the first mention wins; a later repeat is silently dropped). Ranges
// expand in their written direction, so "3-1, 5" → [3, 2, 1, 5].
//   - empty input → { order: [], valid: true }
//   - malformed/out-of-range → { valid: false, message }
export function parseOrderList(input: string, pageCount?: number): OrderListResult {
  const parts = splitParts(input);
  if (parts.length === 0) {
    return { order: [], valid: true };
  }

  const seen = new Set<number>();
  const order: number[] = [];
  for (const part of parts) {
    const parsed = parsePart(part, pageCount);
    if (!parsed.ok) {
      return { order: [], valid: false, message: parsed.message };
    }
    for (const p of parsed.pages) {
      if (!seen.has(p)) {
        seen.add(p);
        order.push(p);
      }
    }
  }

  return { order, valid: true };
}

// Append any page in 1..pageCount missing from `order`, in ascending original
// order, so a reorder always COVERS every page (the ones the user moved come
// first in their chosen order; the rest follow untouched). Pages already in
// `order` keep their position; out-of-range entries in `order` are passed through
// unchanged (the caller validates separately). pageCount < 1 or non-finite → a
// deduped copy of `order` with nothing appended.
export function appendMissing(order: number[], pageCount: number): number[] {
  const present = new Set<number>();
  const result: number[] = [];
  // Carry the existing order through, deduped, so the contract ("each page once")
  // holds even if the caller passes a dirty list.
  for (const p of order) {
    if (!present.has(p)) {
      present.add(p);
      result.push(p);
    }
  }
  if (!Number.isFinite(pageCount) || pageCount < 1) {
    return result;
  }
  for (let p = 1; p <= pageCount; p++) {
    if (!present.has(p)) {
      present.add(p);
      result.push(p);
    }
  }
  return result;
}

// Collapse a list of pages into inclusive ascending runs. Tolerant of unsorted or
// duplicated input — it sorts and de-dupes first — so callers can hand it a raw
// set. [] → []. [1,2,3,4,6,8,9,10] → [{1,4},{6,6},{8,10}].
export function toRanges(pages: number[]): PageRange[] {
  const sorted = Array.from(new Set(pages)).sort((x, y) => x - y);
  const ranges: PageRange[] = [];
  for (const p of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && p === last.end + 1) {
      last.end = p;
    } else {
      ranges.push({ start: p, end: p });
    }
  }
  return ranges;
}

// Render a sorted page set as a compact string: single pages stand alone, runs
// of three or more collapse to "start-end". [] → "". This is what powers
// AUTO-SPLIT: 1..10 with 5 deselected becomes [1,2,3,4,6,7,8,9,10] →
// "1-4, 6-10". A two-page run like [1,2] renders "1, 2" (a dash would not be
// shorter), matching how people write short lists.
export function formatRanges(pages: number[]): string {
  return toRanges(pages)
    .map((r) => {
      if (r.start === r.end) return String(r.start);
      if (r.end === r.start + 1) return `${r.start}, ${r.end}`;
      return `${r.start}-${r.end}`;
    })
    .join(", ");
}
