import { chmod, mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
if (process.platform !== "linux" || !report.header?.glibcVersionRuntime) {
  throw new Error("Pocket executable builds currently require a Linux glibc host.");
}

const project = resolve(import.meta.dir, "..");
const tui = join(project, "server/target/pocket-tui");
await mkdir(join(project, "server/target"), { recursive: true });
console.log("Compiling the TUI with Bun and OpenTUI embedded…");
const result = await Bun.build({
  entrypoints: [join(project, "src/index.ts")],
  minify: true,
  define: { "process.env.OPENTUI_LIBC": JSON.stringify("glibc") },
  compile: {
    outfile: tui,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});
if (!result.success) throw new AggregateError(result.logs, "TUI compilation failed.");

console.log("Embedding the TUI in the Rust SSH server…");
const cargo = Bun.spawn(["cargo", "build", "--release", "--locked", "--manifest-path", "server/Cargo.toml", "--target-dir", "server/target", "--features", "embedded-tui"], {
  cwd: project,
  env: { ...process.env, POCKET_TUI_BINARY: tui },
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
if (await cargo.exited) throw new Error("Rust executable build failed.");
const executable = join(project, "pocket");
const staged = join(project, "server/target/pocket-next");
await Bun.write(staged, Bun.file(join(project, "server/target/release/cute-tui-server")));
await chmod(staged, 0o755);
await rename(staged, executable);
console.log(`Built ${executable}. Run ./pocket [folder].`);
