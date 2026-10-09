import { addDefaultParsers, basenameToFiletype, pathToFiletype } from "@opentui/core";
import rustWasm from "./parsers/rust.wasm" with { type: "file" };
import rustQuery from "./parsers/rust.scm" with { type: "file" };
import pythonWasm from "./parsers/python.wasm" with { type: "file" };
import pythonQuery from "./parsers/python.scm" with { type: "file" };
import jsonWasm from "./parsers/json.wasm" with { type: "file" };
import jsonQuery from "./parsers/json.scm" with { type: "file" };
import bashWasm from "./parsers/bash.wasm" with { type: "file" };
import bashQuery from "./parsers/bash.scm" with { type: "file" };
import yamlWasm from "./parsers/yaml.wasm" with { type: "file" };
import yamlQuery from "./parsers/yaml.scm" with { type: "file" };
import tomlWasm from "./parsers/toml.wasm" with { type: "file" };
import tomlQuery from "./parsers/toml.scm" with { type: "file" };
import htmlWasm from "./parsers/html.wasm" with { type: "file" };
import htmlQuery from "./parsers/html.scm" with { type: "file" };
import cssWasm from "./parsers/css.wasm" with { type: "file" };
import cssQuery from "./parsers/css.scm" with { type: "file" };
import sqlWasm from "./parsers/sql.wasm" with { type: "file" };
import sqlQuery from "./parsers/sql.scm" with { type: "file" };
import cWasm from "./parsers/c.wasm" with { type: "file" };
import cQuery from "./parsers/c.scm" with { type: "file" };
import cppWasm from "./parsers/cpp.wasm" with { type: "file" };
import cppQuery from "./parsers/cpp.scm" with { type: "file" };
import goWasm from "./parsers/go.wasm" with { type: "file" };
import goQuery from "./parsers/go.scm" with { type: "file" };
import javaWasm from "./parsers/java.wasm" with { type: "file" };
import javaQuery from "./parsers/java.scm" with { type: "file" };

// Paired parser/query versions, upstream URLs and MIT notices are in parsers/LICENSE.
// File imports embed assets in ./pocket; no downloads are needed at runtime.
addDefaultParsers([
  { filetype: "rust", wasm: rustWasm, queries: { highlights: [rustQuery] } },
  { filetype: "python", wasm: pythonWasm, queries: { highlights: [pythonQuery] } },
  { filetype: "json", wasm: jsonWasm, queries: { highlights: [jsonQuery] } },
  { filetype: "bash", wasm: bashWasm, queries: { highlights: [bashQuery] } },
  { filetype: "yaml", wasm: yamlWasm, queries: { highlights: [yamlQuery] } },
  { filetype: "toml", wasm: tomlWasm, queries: { highlights: [tomlQuery] } },
  // ponytail: HTML/CSS stay separate; enable injections when Core honors injection.language metadata.
  { filetype: "html", wasm: htmlWasm, queries: { highlights: [htmlQuery] } },
  { filetype: "css", wasm: cssWasm, queries: { highlights: [cssQuery] } },
  { filetype: "sql", wasm: sqlWasm, queries: { highlights: [sqlQuery] } },
  { filetype: "c", wasm: cWasm, queries: { highlights: [cQuery] } },
  { filetype: "cpp", wasm: cppWasm, queries: { highlights: [cQuery, cppQuery] } },
  { filetype: "go", wasm: goWasm, queries: { highlights: [goQuery] } },
  { filetype: "java", wasm: javaWasm, queries: { highlights: [javaQuery] } },
]);
basenameToFiletype.set("pkgbuild", "bash");

const supported = new Set([
  "javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "zig", "rust", "python", "json",
  "bash", "yaml", "toml", "html", "css", "sql", "c", "cpp", "go", "java",
]);
export function previewFiletype(path: string) {
  const filetype = pathToFiletype(path);
  return filetype && supported.has(filetype) ? filetype : undefined;
}


