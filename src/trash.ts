export type TrashEntry = { name: string; uri: string };

function trashName(uri: string) {
  if (!/^trash:\/\/\/[^/\s?#]+$/.test(uri)) throw new Error("Choose an item from the system trash.");
  const name = decodeURIComponent(uri.slice(9));
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\x00")) throw new Error("Invalid trash item.");
  return name;
}

async function gio(args: string[]) {
  if (!Bun.which("gio")) throw new Error("System trash needs gio and a working GVFS trash backend.");
  const child = Bun.spawn(["gio", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (await child.exited) throw new Error(error.trim() || "Trash operation failed. Install GVFS and check the trash backend.");
  return output;
}

export async function trashEntries(): Promise<TrashEntry[]> {
  const output = await gio(["list", "-u", "--", "trash:///"]);
  // URI output encodes tabs/newlines in names, unlike `gio trash --list`'s raw original paths.
  return output.split("\n").filter(Boolean).map(uri => ({ uri, name: trashName(uri) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export async function trashInfo(uri: string) {
  trashName(uri);
  return gio(["info", "-a", "trash::orig-path,trash::deletion-date", "--", uri]);
}

export async function restoreTrash(uri: string) {
  trashName(uri);
  // No --force: GIO restores the original path and refuses existing destinations.
  await gio(["trash", "--restore", "--", uri]);
}

export async function deleteTrash(uri: string) {
  trashName(uri);
  await gio(["remove", "--", uri]);
}
