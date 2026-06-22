# porto-tools/engine

The public, auditable conversion engine that powers
[porto.tools](https://porto.tools). The engine runs **entirely in your browser**
via WebAssembly — your files never leave your device. That is the whole product
promise, and the only way to make a privacy promise credible is to let you
check it yourself.

This snapshot is **byte-identical** to the engine the website actually ships
(see "No drift" below — you can reproduce and re-verify the byte-identity).

## Don't trust us — read it, run it, prove it

We don't ask you to take our word for it. We ask you to verify it:

1. **Read it.** Every line of the engine is here. It's plain TypeScript. Start at
   `engine/conversions/` — each converter is a small, self-contained descriptor.

2. **Run it with your Wi-Fi off.** Pull the engine into a project, kill your
   network, and convert a file. It works offline because there is no server. If
   there were a hidden upload, turning off the network would break it. It won't.

3. **Grep for network calls.** There are none in the conversion path. Check for
   yourself:

   ```sh
   grep -rnE "fetch|XMLHttpRequest|navigator\.sendBeacon|new WebSocket|axios" engine/
   ```

   The only byte-moving APIs in the engine are reading the file you handed it and
   handing the result back. WASM modules are loaded as local assets, not fetched
   from a tracking endpoint.

4. **Diff it against what we ship.** This snapshot is byte-identical to the
   engine in our shipping website — reproduce and re-verify it yourself (below).

## What's here

```
engine/                      <- byte-identical copy of the website's src/engine/** (175 files)
  conversions/               <- one descriptor per conversion (+ .test.ts beside each)
    __fixtures__/            <- tiny real PDFs / images used by the tests
  *.ts                       <- engine core (registry, errors, types, helpers)
  *.test.ts                  <- the test suite ships WITH the engine
  papaparse.d.ts             <- one local type shim
sync-from-website.sh         <- reproduce + re-verify the snapshot (0 deps)
verify-byte-identical.mjs    <- the byte-identity gate (node built-ins only)
LICENSE / LICENSING.md       <- AGPL-3.0 + dual-license terms (see License below)
```

Tests and fixtures are included on purpose. The engine's correctness — including
its error contract (`UNSUPPORTED_INPUT`, `DECODE_FAILED`, `CANCELLED`) — is part
of what you're auditing, so the proof of correctness ships with the code.

## No drift — public == shipping

The public engine must never silently diverge from the engine the website
actually serves. The guarantee is mechanical, not a promise:

```sh
./sync-from-website.sh /path/to/website
```

This (1) mirrors `website/src/engine/**` into `./engine/**` (full replace), then
(2) computes the **sha256 of every file in both trees** and compares them 1:1.
If a single byte differs, or any file is extra/missing, it exits non-zero and
refuses. A clean exit is the proof that what's public is exactly what's shipped.

## License

**Dual-licensed.** Open source under the **GNU AGPL-3.0** (see [`LICENSE`](./LICENSE)) —
free to use, study, modify, self-host, and redistribute under those terms; if you
run a modified version as a network service, the AGPL requires you to offer your
users the corresponding source. A separate **commercial license** is available for
proprietary/closed-source embedding — see [`LICENSING.md`](./LICENSING.md)
(contact: licensing@porto.tools). Third-party components (FFmpeg/libheif LGPL,
qpdf/pdf.js Apache-2.0) remain under their own licenses.
