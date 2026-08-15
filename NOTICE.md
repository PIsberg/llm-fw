# Third-party notices

llm-fw itself is licensed under PolyForm Noncommercial 1.0.0 (see `LICENSE.md`).
This file records third-party components in the installed dependency tree whose
licenses are something other than the usual permissive set (MIT, ISC, Apache-2.0,
BSD-2/3-Clause, 0BSD), so that anyone auditing the package does not have to
rediscover them.

Regenerate the underlying data with:

```
npm query ".prod:not([license=MIT]):not([license=ISC]):not([license=Apache-2.0]):not([license=BSD-3-Clause]):not([license=BSD-2-Clause]):not([license=0BSD])"
```

## libvips, via sharp (LGPL-3.0-or-later)

This is the only entry with real obligations attached.

`sharp` is a hard dependency of `@huggingface/transformers`, which llm-fw depends
on for its text classifiers. sharp ships its native libvips build as
platform-specific optional packages, and those carry LGPL-3.0-or-later:

| Package | License |
| --- | --- |
| `@img/sharp-libvips-{linux,linuxmusl,darwin}-*` | `LGPL-3.0-or-later` |
| `@img/sharp-win32-{x64,arm64}` | `Apache-2.0 AND LGPL-3.0-or-later` |
| `sharp`, `@img/sharp-{linux,darwin}-*` | `Apache-2.0` |

On Linux and macOS libvips arrives as its own `@img/sharp-libvips-*` package. On
Windows it is statically bundled into `@img/sharp-win32-*`, which is why those
two are dual-tagged. libvips is therefore present on every platform.

Position: llm-fw does not import sharp. It is pulled in transitively and is only
reachable through image pipelines that llm-fw never constructs; the detection
code (`src/detection/classifier.ts`, `embedding.ts`, `outputClassifier.ts`) uses
text pipelines only. The libvips binaries are distributed unmodified by npm as
separate packages, are dynamically linked, and can be replaced by the user
without rebuilding llm-fw.

Commercial licensees who redistribute llm-fw as part of a larger product should
confirm this reading with their own counsel rather than relying on this file.
It records what is in the tree and why; it is not a legal opinion.

### The sharp advisories a fresh install reports

`npm install llm-fw` currently reports 5 high-severity advisories, and names
llm-fw in the chain. This is worth explaining rather than leaving a security
tool looking careless about its own tree.

```
sharp  <0.35.0   high   4 libvips CVEs (GHSA-f88m-g3jw-g9cj)
adm-zip <0.6.0   ...    GHSA-xcpc-8h2w-3j85
```

Both arrive through `@huggingface/transformers`, whose latest release (4.2.0)
still pins `sharp: ^0.34.5`. `^0.34.5` cannot resolve to 0.35.x, so no range
change here reaches it, and adding `sharp` as a direct dependency does not help
either: npm then installs BOTH copies, hoisting ours and leaving transformers
on its own nested 0.34.5. The `overrides` block in `package.json` does not
reach installs of llm-fw at all, for the reason documented there. The fix has
to land upstream.

On exposure: the libvips CVEs are reached by decoding untrusted images through
sharp. llm-fw never imports sharp — the detection code uses text pipelines
only, and OCR (opt-in, off by default) goes through tesseract.js, not sharp. So
the vulnerable code is present in the tree but is not on any path llm-fw
executes. An application that uses sharp itself is affected on its own terms
and should pin its own copy.

## Permissive but flagged by scanners

Neither of these creates an obligation beyond attribution. They are listed
because automated tooling (Socket, and license scanners with strict allowlists)
reports them as non-permissive or copyleft.

- `node-forge` is `(BSD-3-Clause OR GPL-2.0)`. This is a dual license and the
  choice is the recipient's; llm-fw takes it under BSD-3-Clause.
- `argparse@2.0.1`, reached through `cosmiconfig` and `js-yaml`, is `Python-2.0`.
  That is a permissive license, but it is absent from most allowlists.

## Optional peer dependency

`tesseract.js` (Apache-2.0) is an optional peer dependency, not a runtime
dependency. It is installed only when a user opts into OCR (`nonText.ocr`), so
it and its own tree are absent from a default install. See the note above the
`peerDependencies` block in `package.json`.
