// Shared cancellation helper for Canvas-based (and future ffmpeg) conversions.
//
// Engine firewall: this file imports ONLY the sibling types module and
// node_modules. It never reaches into app/components/lib. See types.ts.

import { ConversionError } from "../types";

// Throw the canonical CANCELLED error if the caller aborted. Called at each
// async boundary. `cleanup` releases any bitmap we've already decoded so an
// abort mid-flight doesn't leak GPU/native memory. The pattern is overkill for
// instant Canvas jobs but is the contract ffmpeg conversions will inherit.
export function throwIfAborted(signal: AbortSignal | undefined, cleanup?: () => void): void {
  if (signal?.aborted) {
    cleanup?.();
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}
