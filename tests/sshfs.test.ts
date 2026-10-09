import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, rename, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { Database } from "bun:sqlite";
import { InputRenderable, SelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { buildApp } from "../src/ui";
import { remoteTarget, remoteMounts, bookmarkPath, mountRemote, unmountRemote } from "../src/sshfs";

test("SSHFS targets reject options, credentials and control characters", () => {
  expect(remoteTarget("work:/")).toBe("work:/");
  expect(remoteTarget("cat@host:/home/cat/../cat/")).toBe("cat@host:/home/cat");
  expect(remoteTarget("cat@[::1]:/folder with 'quotes' $name;literal")).toBe("cat@[::1]:/folder with 'quotes' $name;literal");
  for (const target of ["", "-o:/path", "host:relative", "user:password@host:/path", "host:/bad\npath", "host:/bad\x00path", "bad host:/path"]) {
    expect(() => remoteTarget(target)).toThrow();
  }
});

test.skipIf(process.env.POCKET_SSHFS_TEST !== "1")("SSHFS bookmarks reconnect and copy/move safely between local and remote folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-sshfs-test-"));
  const local = join(directory, "local"), remote = join(directory, "remote folder"), mounts = join(directory, "mounts");
  const database = join(directory, "bookmarks.sqlite"), config = join(directory, "ssh-config");
  const sshfs = Bun.which("sshfs"), sshdPath = Bun.which("sshd");
  const spawn = Bun.spawn;
  let daemon: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined, launch: ReturnType<typeof spyOn> | undefined;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
  let app: ReturnType<typeof buildApp>;
  async function command(args: string[]) {
    const child = spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    if (await child.exited) throw new Error(error);
  }
  async function waitFor(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
      await Bun.sleep(10); await setup?.renderOnce();
      if (await check()) return;
    }
    throw new Error(`SSHFS UI did not finish: ${setup?.captureCharFrame()}`);
  }
  async function paste(message: string) {
    setup!.mockInput.pressKey("p");
    await waitFor(() => setup!.captureCharFrame().includes(message));
  }
  try {
    expect(sshfs).toBeTruthy(); expect(sshdPath).toBeTruthy();
    await mkdir(local); await mkdir(remote); await mkdir(join(remote, "subfolder"));
    await Bun.write(join(local, "local 'quote' $name.txt"), "from local\n");
    await Bun.write(join(remote, "remote.txt"), "from remote\n");
    await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(directory, "client")]);
    await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(directory, "host")]);
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port; listener.stop(true);
    await Bun.write(join(directory, "sshd-config"), `Port ${port}\nListenAddress 127.0.0.1\nHostKey "${directory}/host"\nPidFile "${directory}/sshd.pid"\nAuthorizedKeysFile "${directory}/client.pub"\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${userInfo().username}\nSubsystem sftp internal-sftp\n`);
    await Bun.write(join(directory, "known-hosts"), `[127.0.0.1]:${port} ${(await Bun.file(join(directory, "host.pub")).text()).trim()}\n`);
    await Bun.write(config, `Host pocket-test\n  HostName 127.0.0.1\n  Port ${port}\n  User ${userInfo().username}\n  IdentityFile "${directory}/client"\n  IdentitiesOnly yes\n  UserKnownHostsFile "${directory}/known-hosts"\n  StrictHostKeyChecking yes\n  BatchMode yes\n`);
    daemon = spawn([sshdPath!, "-D", "-e", "-f", join(directory, "sshd-config")], { stdout: "ignore", stderr: "pipe" });
    await waitFor(async () => {
      if (daemon!.exitCode !== null) throw new Error(await new Response(daemon!.stderr).text());
      try { const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data(socket) { socket.end(); }, error() {} } }); socket.end(); return true; }
      catch { return false; }
    });
    launch = spyOn(Bun, "spawn").mockImplementation(((command: unknown, options?: Parameters<typeof spawn>[1]) => {
      if (!Array.isArray(command)) throw new Error("Expected argument-array subprocess.");
      return spawn(command[0] === sshfs ? [...command, "-o", `ssh_command=ssh -F ${config}`] : command, options);
    }) as typeof spawn);
    setup = await createTestRenderer({ width: 110, height: 30 });
    app = buildApp(setup.renderer, local, database); await app.ready;
    setup.mockInput.pressKey("B");
    setup.mockInput.pressKey("c"); await setup.renderOnce();
    let input = setup.renderer.root.findDescendantById("dialog-input") as InputRenderable;
    expect(setup.renderer.root.findDescendantById("dialog")!.height).toBe(6);
    input.value = "-o:/bad"; setup.mockInput.pressEnter();
    await waitFor(() => setup!.captureCharFrame().includes("Use an SSH alias"));
    expect(app.cwd).toBe(local); expect(remoteMounts(mounts)).toEqual([]);
    input.value = `pocket-test:${remote}`; setup.mockInput.pressEnter();
    await waitFor(() => !setup!.renderer.root.findDescendantById("dialog"));
    expect(remoteMounts(mounts).length).toBe(1);
    const mounted = app.cwd;
    expect(await mountRemote(`pocket-test:${remote}`, mounts)).toBe(mounted);
    expect(remoteMounts(mounts).length).toBe(1);
    expect(await Bun.file(join(mounted, "remote.txt")).text()).toBe("from remote\n");
    setup.mockInput.pressKey("B");
    expect(bookmarkPath(mounted, mounts)).toBe(`sshfs:pocket-test:${remote}`);
    await app.load(join(mounted, "subfolder")); setup.mockInput.pressKey("B");
    expect(bookmarkPath(app.cwd, mounts)).toBe(`sshfs:pocket-test:${remote}/subfolder`);
    const subfolder = await mountRemote(`sshfs:pocket-test:${remote}/subfolder`, mounts);
    expect(bookmarkPath(subfolder, mounts)).toBe(`sshfs:pocket-test:${remote}/subfolder`);
    await unmountRemote(subfolder, mounts);
    await app.load(local, join(local, "local 'quote' $name.txt")); setup.mockInput.pressKey("y");
    await app.load(`sshfs:pocket-test:${remote}`); await paste("Copy pasted.");
    expect(await Bun.file(join(remote, "local 'quote' $name.txt")).text()).toBe("from local\n");
    await paste("EEXIST");
    expect(await Bun.file(join(remote, "local 'quote' $name.txt")).text()).toBe("from local\n");
    await app.load(mounted, join(mounted, "remote.txt")); setup.mockInput.pressKey("y");
    await app.load(local); await paste("Copy pasted.");
    expect(await Bun.file(join(local, "remote.txt")).text()).toBe("from remote\n");
    await Bun.write(join(remote, "move.txt"), "move from remote\n");
    await app.load(mounted, join(mounted, "move.txt")); setup.mockInput.pressKey("x");
    await app.load(local); await paste("Move pasted.");
    expect(await Bun.file(join(local, "move.txt")).text()).toBe("move from remote\n");
    expect(await Bun.file(join(remote, "move.txt")).exists()).toBe(false);
    await Bun.write(join(local, "blocked.txt"), "keep local\n"); await Bun.write(join(remote, "blocked.txt"), "keep remote\n");
    await app.load(local, join(local, "blocked.txt")); setup.mockInput.pressKey("x");
    await app.load(mounted); await paste("That name already exists");
    expect(await Bun.file(join(local, "blocked.txt")).text()).toBe("keep local\n");
    expect(await Bun.file(join(remote, "blocked.txt")).text()).toBe("keep remote\n");
    await rename(join(remote, "blocked.txt"), join(remote, "occupied.txt"));
    await paste("Move pasted.");
    expect(await Bun.file(join(remote, "blocked.txt")).text()).toBe("keep local\n");
    expect(await Bun.file(join(local, "blocked.txt")).exists()).toBe(false);
    const stored = new Database(database, { readonly: true });
    expect(stored.query<{ path: string }, []>("SELECT path FROM bookmarks ORDER BY path").all().map(row => row.path)).toEqual([local, `sshfs:pocket-test:${remote}`, `sshfs:pocket-test:${remote}/subfolder`]);
    stored.close();
    const handle = await open(join(mounted, "remote.txt"), "r");
    try {
      await expect(unmountRemote(mounted, mounts)).rejects.toThrow();
      expect(remoteMounts(mounts).length).toBe(1);
    } finally { await handle.close(); }
    setup.renderer.destroy(); await unmountRemote(mounted, mounts);
    setup = await createTestRenderer({ width: 54, height: 18 });
    app = buildApp(setup.renderer, local, database); await app.ready;
    setup.mockInput.pressKey("b"); await setup.renderOnce();
    const picker = setup.renderer.root.findDescendantById("bookmark-picker") as SelectRenderable;
    picker.setSelectedIndex(picker.options.findIndex(option => option.value === `sshfs:pocket-test:${remote}`));
    setup.mockInput.pressEnter(); await waitFor(() => !setup!.renderer.root.findDescendantById("dialog"));
    expect(app.cwd).toBe(mounted); expect(remoteMounts(mounts).length).toBe(1);
    setup.mockInput.pressKey("u"); await waitFor(() => remoteMounts(mounts).length === 0);
    await waitFor(() => setup!.captureCharFrame().includes("Disconnected"));
    await expect(mountRemote("pocket-test:/does-not-exist", mounts)).rejects.toThrow();
    expect(remoteMounts(mounts)).toEqual([]);
  } finally {
    setup?.renderer.destroy();
    for (const mount of remoteMounts(mounts)) await unmountRemote(mount.path, mounts);
    launch?.mockRestore(); daemon?.kill(); if (daemon) await daemon.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
