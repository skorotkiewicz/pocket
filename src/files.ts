import { readdir, stat, lstat, mkdir, open, cp } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

export type Entry = { name: string; path: string; directory: boolean; link: boolean };
export const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�");
export const kind = (path: string) => {
  const ext = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".opus", ".aac"].includes(ext)) return "music";
  if ([".mkv", ".mp4", ".m4v", ".mov", ".avi", ".webm", ".mpg", ".mpeg", ".wmv", ".flv", ".3gp", ".ogv",
    ".pdf", ".epub", ".doc", ".docx", ".odt", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp", ".rtf",
    ".svg", ".html", ".htm", ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".iso"].includes(ext)) return "external";
  return "text";
};
export const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export async function entries(path: string): Promise<Entry[]> {
  const items = await readdir(path, { withFileTypes: true });
  return Promise.all(items.map(async (item) => {
    const full = join(path, item.name);
    let directory = item.isDirectory();
    if (item.isSymbolicLink()) directory = await stat(full).then(s => s.isDirectory(), () => false);
    return { name: item.name, path: full, directory, link: item.isSymbolicLink() };
  })).then(items => items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true })));
}

export function childPath(directory: string, name: string) {
  if (!name.trim() || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name)) throw new Error("Use a single file name, without slashes or control characters.");
  return join(directory, name);
}

export async function create(directory: string, name: string, folder: boolean) {
  const path = childPath(directory, name);
  if (folder) await mkdir(path);
  else { const handle = await open(path, "wx"); await handle.close(); }
  return path;
}

export async function copyInto(source: string, directory: string) {
  const target = join(directory, basename(source));
  if (resolve(source) === resolve(target)) throw new Error("Choose a different folder before pasting.");
  // cp refuses existing files; no silent overwrite of the user's work.
  await cp(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  return target;
}

export async function moveInto(source: string, directory: string) {
  const target = join(directory, basename(source));
  if (resolve(source) === resolve(target)) throw new Error("Choose a different folder before pasting.");
  return moveEntry(source, target);
}

export async function renameEntry(source: string, name: string) {
  const target = childPath(resolve(source, ".."), name);
  if (source === target) return target;
  return moveEntry(source, target);
}

async function moveEntry(source: string, target: string) {
  try { await lstat(target); throw new Error("That name already exists."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // GNU mv provides a no-clobber rename, including directories, without a race-prone overwrite.
  const child = Bun.spawn(["mv", "-nT", "--", source, target], { stdout: "ignore", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(error || "Move failed. GNU mv is required.");
  try { await lstat(source); throw new Error("That name already exists. Nothing was overwritten."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}

export async function openExternal(path: string) {
  const gio = Bun.which("gio"), opener = gio ?? Bun.which("xdg-open");
  if (!opener) throw new Error("Install gio or xdg-utils to open files in the host's default app.");
  const command = gio ? [gio, "open", "--", resolve(path)] : [opener, resolve(path)];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  const code = await child.exited;
  if (code) throw new Error(`Host opener exited with status ${code}. Check the default app and host desktop session.`);
}

export const BINARY_PREVIEW = "Binary file.\nEnter in files or o opens the host's default app.";
export async function textPreview(path: string) {
  const bytes = new Uint8Array(await Bun.file(path).slice(0, 64 * 1024).arrayBuffer());
  if (bytes.includes(0)) return BINARY_PREVIEW;
  // ponytail: sniff only the first 64 KB as UTF-8; use MIME/charset detection if other encodings matter.
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: bytes.length === 64 * 1024 }); }
  catch { return BINARY_PREVIEW; }
  const text = clean(decoded);
  return text.split("\n").slice(0, 500).map((line, i) => `${String(i + 1).padStart(4)}  ${line.replace(/\t/g, "  ")}`).join("\n") + (bytes.length === 64 * 1024 ? "\n… Preview limited to 64 KB" : "");
}

export function waveform(bytes: Uint8Array, width = 44) {
  const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.length / 4);
  if (!count) return "No waveform available";
  const levels = Array.from({ length: width }, (_, bin) => {
    const start = Math.floor(bin * count / width), end = Math.floor((bin + 1) * count / width);
    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(samples.getFloat32(i * 4, true)));
    return peak;
  });
  const max = Math.max(...levels, 0.001);
  return levels.map(p => "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(p / max * 7))]).join("");
}

export async function musicPreview(path: string) {
  if (!Bun.which("ffprobe") || !Bun.which("ffmpeg")) return "Music file\n\nInstall ffmpeg for tags and waveform.\nPress Space to play with ffplay.";
  const probe = Bun.spawn(["ffprobe", "-v", "quiet", "-show_format", "-of", "json", path], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => probe.kill(), 10_000);
  let info: { format?: { duration?: string; tags?: Record<string, string> } };
  try { info = await new Response(probe.stdout).json() as typeof info; if (await probe.exited) throw new Error("Cannot read audio metadata."); }
  finally { clearTimeout(timeout); }
  const tags = info.format?.tags ?? {};
  const seconds = Number(info.format?.duration ?? 0);
  const decode = Bun.spawn(["ffmpeg", "-v", "error", "-i", path, "-t", "30", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => decode.kill(), 10_000);
  let wave: string;
  try { wave = waveform(new Uint8Array(await new Response(decode.stdout).arrayBuffer())); await decode.exited; }
  finally { clearTimeout(timer); }
  return clean(`♪  ${tags.title ?? tags.TITLE ?? basename(path)}\n\n${tags.artist ?? tags.ARTIST ?? "Unknown artist"}\n${tags.album ?? tags.ALBUM ?? ""}\n\n${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}\n\n${wave}\nFirst 30 seconds\n\nSpace  play / stop\nAudio plays on the host, not the SSH client.`);
}
