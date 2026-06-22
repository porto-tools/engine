// Shared filename rule for every conversion: strip the source file's final
// extension and append the target one. Replace the LAST extension only, so
// `vacation.png` → `vacation.jpg` and `my.photo.png` → `my.photo.jpg`.
//
// Deliberately does NOT add the site name, a suffix, or collision numbers.
// Single-file downloads let the browser resolve name collisions; numbering
// only happens later inside ZIP archives (not handled here).
export function replaceExtension(filename: string, newExtension: string): string {
  // lastIndexOf finds the final dot; a leading-dot dotfile with no other dot
  // (".env") has its dot at index 0, which we treat as "no extension to strip".
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.${newExtension}`;
}
