# Parser assets

WASM parsers and highlight queries are paired at the upstream versions listed in `LICENSE`. Most WASM files come from each upstream GitHub release. C++ uses both the C and C++ highlight queries. HTML and CSS are highlighted separately. The upstream `html-injections.scm` is retained but not registered: OpenTUI 0.5.17's worker does not honor its `injection.language` metadata.

`src/syntax.ts` imports these files through Bun's file loader, so `./pocket` includes them and does not download grammars at runtime. Release archives carry the combined notices; PKGBUILD installs them as `tree-sitter-LICENSE`.

## SQL build

SQL v0.3.11 has no prebuilt WASM release. Its asset was compiled from `@derekstride/tree-sitter-sql@0.3.11`, matching upstream commit `7b51ecda191d36b92f5a90a8d1bc3faef1c7b8b8`, with Clang 22.1.8 and Zig 0.16.0's libc headers. No compiler is needed to run or build Pocket from the checked-in assets.

To reproduce in a temporary directory on an Arch host with those tools:

```sh
curl -fLsS https://registry.npmjs.org/@derekstride/tree-sitter-sql/-/tree-sitter-sql-0.3.11.tgz | tar -xz
clang --target=wasm32-wasip1 -Os -fPIC -fvisibility=hidden -fno-exceptions -nostdlib \
  -isystem /usr/lib/zig/include \
  -isystem /usr/lib/zig/libc/include/wasm-wasi-musl \
  -isystem /usr/lib/zig/libc/include/generic-musl \
  -I package/src package/src/parser.c package/src/scanner.c \
  -Wl,--shared -Wl,--export=tree_sitter_sql -Wl,--allow-undefined \
  -o sql.wasm
```

The SQL query is the package's `queries/highlights.scm`. The generated WASM is tested through OpenTUI's worker, not just checked for a valid file header.
