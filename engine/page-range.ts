// parsePageRange — turn a human page-range string ("1-3,5,8-10") into a sorted,
// de-duplicated list of 1-based page numbers, clamped to [1, pageCount].
//
// This lives in the engine (not src/lib) on purpose: converters that need to
// honour a page-range control parse the raw string here, and the engine may
// never import from src/lib. The (engine-free) ControlPanel does its own LIVE
// validation with a mirror helper in src/lib/controls.ts; this function is the
// authoritative parse the conversion runs against.
//
// Grammar (whitespace anywhere is ignored):
//   - comma-separated parts
//   - a part is either a single page "5" or a range "8-10" (inclusive)
//   - an EMPTY string means "all pages" (1..pageCount) — the common default
//
// Behaviour notes:
//   - Pages outside [1, pageCount] are clamped/dropped rather than throwing, so
//     a stale range against a shorter document degrades gracefully.
//   - A reversed range ("10-8") is read in either direction (normalised).
//   - The result is sorted ascending and contains no duplicates, so "1,1,2" and
//     "2,1" both yield [1, 2].
//   - A syntactically invalid part (non-numeric, e.g. "abc") is skipped; if
//     NOTHING parses to a valid in-range page, an empty array is returned. The
//     UI validates first, so converters can treat [] as "nothing to do".

export function parsePageRange(str: string, pageCount: number): number[] {
  // No usable document → nothing to select, regardless of the string.
  if (!Number.isFinite(pageCount) || pageCount < 1) return [];

  const trimmed = str.trim();

  // Empty = all pages. This is the `allowAll` default for page-range controls.
  if (trimmed === "") {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }

  const pages = new Set<number>();

  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (part === "") continue;

    const dash = part.indexOf("-");
    if (dash === -1) {
      // Single page.
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1 && n <= pageCount) pages.add(n);
      continue;
    }

    // Range "a-b" (inclusive). Normalise reversed ranges.
    const a = Number(part.slice(0, dash).trim());
    const b = Number(part.slice(dash + 1).trim());
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(pageCount, Math.max(a, b));
    for (let n = lo; n <= hi; n++) pages.add(n);
  }

  return Array.from(pages).sort((x, y) => x - y);
}
