import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join, resolve, posix } from "node:path";

const prefix = "sshfs:";
const decodeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

export function remoteTarget(value: string) {
  const match = /^(?:[a-zA-Z0-9_.-]+@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:.%_-]+\]):(\/.*)$/.exec(value);
  if (!match || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Use an SSH alias or user@host:/absolute/path. Configure ports and keys in ~/.ssh/config.");
  return value.slice(0, value.length - match[1]!.length) + posix.normalize(match[1]!).replace(/(.+)\/$/, "$1");
}

export function remoteMounts(root: string) {
  // Linux mountinfo is kernel-owned; never mistake an empty, unmounted folder for a connection.
  return readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").flatMap(line => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    if (separator < 0 || fields[separator + 1] !== "fuse.sshfs") return [];
    const path = decodeMount(fields[4]!), target = decodeMount(fields[separator + 2]!);
    return path.startsWith(resolve(root) + "/") ? [{ path, target }] : [];
  });
}

export function currentRemote(path: string, root: string) {
  path = resolve(path);
  if (!path.startsWith(resolve(root) + "/")) return;
  return remoteMounts(root).find(mount => path === mount.path || path.startsWith(mount.path + "/"));
}

export function bookmarkPath(path: string, root: string) {
  const mount = currentRemote(path, root);
  if (!mount) return path;
  const suffix = resolve(path).slice(mount.path.length);
  return prefix + remoteTarget(suffix ? mount.target.replace(/\/$/, "") + suffix : mount.target);
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) {
    throw new Error(`SSHFS mount folders must be owned by you with mode 0700: ${path}`);
  }
}

export async function mountRemote(value: string, root: string) {
  const target = remoteTarget(value.startsWith(prefix) ? value.slice(prefix.length) : value);
  const sshfs = Bun.which("sshfs");
  if (!sshfs) throw new Error("Install sshfs to connect to remote folders.");
  await privateDirectory(root);
  const path = join(resolve(root), createHash("sha256").update(target).digest("hex"));
  const existing = remoteMounts(root).find(mount => mount.path === path);
  if (existing) {
    if (existing.target !== target) throw new Error("The SSHFS mount folder is already used by another target.");
    try { await readdir(path); return path; }
    catch (error) {
      if (!["ENOTCONN", "EIO", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await unmountRemote(path, root);
    }
  }
  await privateDirectory(path);
  if ((await readdir(path)).length) throw new Error("SSHFS mount folder is not empty. Nothing was mounted over it.");
  // ponytail: uncached metadata keeps refresh/retry correct; use bounded caching if high RTT makes browsing too slow.
  const child = Bun.spawn([sshfs, target, path, "-o", "BatchMode=yes,StrictHostKeyChecking=yes,ConnectTimeout=10,ServerAliveInterval=5,ServerAliveCountMax=2,transform_symlinks,dir_cache=no,attr_timeout=0,entry_timeout=0,negative_timeout=0"], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 20_000,
  });
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(error.trim() || "SSHFS connection failed or timed out. Set up SSH keys/agent and trust the host with ssh first.");
  if (!remoteMounts(root).some(mount => mount.path === path && mount.target === target)) throw new Error("SSHFS exited without mounting the remote folder.");
  return path;
}

export async function unmountRemote(path: string, root: string) {
  const mount = currentRemote(path, root);
  if (!mount) throw new Error("Choose a connected SSHFS folder first.");
  const unmount = Bun.which("fusermount3") ?? Bun.which("fusermount");
  if (!unmount) throw new Error("Install FUSE tools to disconnect SSHFS folders.");
  // No lazy or forced unmount: open files and unfinished writes must not be discarded.
  const child = Bun.spawn([unmount, "-u", "--", mount.path], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 20_000 });
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(error.trim() || "Could not disconnect SSHFS. Close files using this mount and try again.");
  return mount;
}

export const isRemoteBookmark = (path: string) => path.startsWith(prefix);
