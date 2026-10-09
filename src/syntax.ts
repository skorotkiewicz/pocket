import { addDefaultParsers, pathToFiletype } from "@opentui/core";
import rustWasm from "./parsers/rust.wasm" with { type: "file" };
import rustQuery from "./parsers/rust.scm" with { type: "file" };
import pythonWasm from "./parsers/python.wasm" with { type: "file" };
import pythonQuery from "./parsers/python.scm" with { type: "file" };
import jsonWasm from "./parsers/json.wasm" with { type: "file" };
import jsonQuery from "./parsers/json.scm" with { type: "file" };

// Paired parser/query versions: Rust v0.23.2, Python v0.23.6, JSON v0.24.8.
// Upstream URLs and MIT notices are in parsers/LICENSE. File imports embed assets in ./pocket.
addDefaultParsers([
  { filetype: "rust", wasm: rustWasm, queries: { highlights: [rustQuery] } },
  { filetype: "python", wasm: pythonWasm, queries: { highlights: [pythonQuery] } },
  { filetype: "json", wasm: jsonWasm, queries: { highlights: [jsonQuery] } },
]);

const supported = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "zig", "rust", "python", "json"]);
export function previewFiletype(path: string) {
  const filetype = pathToFiletype(path);
  return filetype && supported.has(filetype) ? filetype : undefined;
}


