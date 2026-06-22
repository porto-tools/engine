// Shared numeric-option readers — the single home for "coerce an untrusted UI
// value into a clamped integer". Folds together what used to be duplicated as
// png-jpg's `clampQuality` and audio-settings' `readClampedInt` so there is no
// third copy of the same three-line clamp.
//
// Engine firewall: this file imports ONLY node_modules (nothing at all here) and
// never reaches into app/components/lib. See types.ts.

// JPEG quality bounds/default, mirroring png-jpg's prior local constants. Kept
// here so clampQuality stays a thin, byte-identical wrapper over clampInt.
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

// Coerce, reject non-finite, round, clamp to range. Missing or non-numeric input
// falls back to `fallback`. This is the general integer-clamp every numeric
// option reader composes from.
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Read the quality option (percent) defensively, clamping to [10, 100]. Missing
// or non-numeric falls back to the default. Expressed via clampInt so the bounds
// and rounding live in exactly one place; behavior is byte-identical to the old
// inline implementation.
export function clampQuality(value: unknown): number {
  return clampInt(value, MIN_QUALITY, MAX_QUALITY, DEFAULT_QUALITY);
}
