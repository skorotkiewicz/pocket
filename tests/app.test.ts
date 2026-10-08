import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, symlink, lstat, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageRenderable, InputRenderable, SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { buildApp } from "../src/ui";
import { childPath, create, copyInto, moveInto, renameEntry, entries, textPreview, waveform, musicPreview } from "../src/files";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pocket-test-"));
  await Bun.write(join(directory, "hello.txt"), "Hello, pocket!\nSecond line\n");
  await Bun.write(join(directory, ".hidden"), "secret");
  await mkdir(join(directory, "folder"));
  return directory;
}

test("file operations protect existing content, links and unusual names", async () => {
  const directory = await fixture();
  try {
    expect(() => childPath(directory, "../escape")).toThrow();
    expect(() => childPath(directory, "bad\x1bname")).toThrow();
    await expect(create(directory, "hello.txt", false)).rejects.toThrow();
    const odd = await create(directory, "a 'quote' $name.txt", false);
    const renamed = await renameEntry(odd, "renamed.txt");
    expect(await Bun.file(renamed).exists()).toBe(true);
    await expect(renameEntry(renamed, "hello.txt")).rejects.toThrow();
    expect(await Bun.file(join(directory, "hello.txt")).text()).toContain("Hello, pocket!");
    const target = join(directory, "folder");
    const copied = await copyInto(join(directory, "hello.txt"), target);
    await expect(copyInto(join(directory, "hello.txt"), target)).rejects.toThrow();
    expect(await Bun.file(copied).text()).toContain("Hello, pocket!");
    await symlink(join(directory, "hello.txt"), join(directory, "link"));
    await copyInto(join(directory, "link"), target);
    expect((await lstat(join(target, "link"))).isSymbolicLink()).toBe(true);
    await renameEntry(target, "renamed-folder");
    expect((await entries(directory))[0]?.directory).toBe(true);
    const renamedFolder = join(directory, "renamed-folder");
    await expect(moveInto(join(directory, "hello.txt"), renamedFolder)).rejects.toThrow();
    const moved = await moveInto(renamed, renamedFolder);
    expect(await Bun.file(moved).exists()).toBe(true);
    await expect(lstat(renamed)).rejects.toThrow();
    await expect(moveInto(renamedFolder, renamedFolder)).rejects.toThrow();
    expect(await Bun.file(join(renamedFolder, "hello.txt")).text()).toContain("Hello, pocket!");
    await symlink("missing.txt", join(directory, "broken-link"));
    const movedLink = await moveInto(join(directory, "broken-link"), renamedFolder);
    expect((await lstat(movedLink)).isSymbolicLink()).toBe(true);
    const destination = await create(directory, "destination", true);
    const movedFolder = await moveInto(renamedFolder, destination);
    expect(await Bun.file(join(movedFolder, "hello.txt")).text()).toContain("Hello, pocket!");
    expect(await textPreview(join(directory, "hello.txt"))).toContain("   1  Hello, pocket!");
    await Bun.write(join(directory, "binary"), new Uint8Array([0, 1, 2]));
    expect(await textPreview(join(directory, "binary"))).toContain("Binary file");
    const samples = new Float32Array([0, 0.2, 0.5, 1]);
    expect(waveform(new Uint8Array(samples.buffer), 4)).toBe("▁▂▄█");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("OpenTUI renders, navigates, filters, opens help and creates files", async () => {
  const directory = await fixture();
  const setup = await createTestRenderer({ width: 110, height: 30 });
  try {
    const app = buildApp(setup.renderer, directory, ":memory:");
    await app.ready;
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("pocket");
    expect(setup.captureCharFrame()).toContain("folder/");
    expect(setup.captureCharFrame()).not.toContain(".hidden");
    setup.mockInput.pressEnter();
    await Bun.sleep(40);
    expect(app.cwd).toBe(join(directory, "folder"));
    setup.mockInput.pressBackspace();
    await Bun.sleep(40);
    expect(app.cwd).toBe(directory);
    setup.mockInput.pressKey(".");
    await Bun.sleep(10);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain(".hidden");
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("hello");
    setup.mockInput.pressEnter();
    await Bun.sleep(40);
    expect(app.list.options.length).toBe(1);
    expect(app.list.getSelectedOption()?.value.name).toBe("hello.txt");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Hello, pocket!");
    setup.mockInput.pressEscape();
    await Bun.sleep(60);
    setup.mockInput.pressKey("?");
    await Bun.sleep(10);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("A tiny field guide");
    setup.mockInput.pressEscape();
    await Bun.sleep(60);
    setup.mockInput.pressKey("n");
    await setup.mockInput.typeText("new.txt");
    setup.mockInput.pressEnter();
    await Bun.sleep(50);
    expect(await Bun.file(join(directory, "new.txt")).exists()).toBe(true);
    setup.resize(54, 18);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("new.txt");
    setup.mockInput.pressTab();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("peek inside");
    app.share();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Rust SSH");
  } finally {
    setup.renderer.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("image previews decode to terminal blocks and music previews read real tags and waveform", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-media-"));
  const setup = await createTestRenderer({ width: 90, height: 26 });
  try {
    const png = join(directory, "pixel.png");
    await Bun.write(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    await Bun.sleep(80);
    const image = setup.renderer.root.findDescendantById("preview-image") as ImageRenderable;
    await image.loadPromise; await setup.renderOnce();
    expect(image.loadError).toBeNull();
    expect(image.image?.width).toBe(1);
    expect(image.effectiveProtocol).toBe("blocks");
    if (Bun.which("ffmpeg")) {
      const audio = join(directory, "tone.wav");
      const makeAudio = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "title=Tiny tune", audio], { stdout: "ignore", stderr: "ignore" });
      expect(await makeAudio.exited).toBe(0);
      const content = await musicPreview(audio);
      expect(content).toContain("Tiny tune");
      expect(content).toContain("0:01");
      expect(content).toContain("█");
    }
  } finally { setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("Enter copies ready preview text after keyboard or mouse focus and reports clipboard failures", async () => {
  const directory = await fixture();
  const setup = await createTestRenderer({ width: 90, height: 26 });
  const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
  try {
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    app.list.setSelectedIndex(app.list.options.findIndex(option => option.value.name === "hello.txt"));
    setup.mockInput.pressTab();
    setup.mockInput.pressEnter();
    expect(copy).not.toHaveBeenCalled();
    await setup.waitForFrame(frame => frame.includes("Hello, pocket!"));
    setup.mockInput.pressEnter();
    expect(copy).toHaveBeenCalledWith(await textPreview(join(directory, "hello.txt")));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Preview text sent");
    setup.mockInput.pressTab();
    const panel = setup.renderer.root.findDescendantById("preview")!;
    await setup.mockMouse.click(panel.x + 2, panel.y);
    copy.mockReturnValue(false);
    setup.mockInput.pressEnter();
    expect(copy).toHaveBeenCalledTimes(2);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Terminal clipboard unavailable");
  } finally {
    copy.mockRestore(); setup.renderer.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("selecting the pairing password copies only the selection on mouse release", async () => {
  const directory = await fixture();
  const setup = await createTestRenderer({ width: 110, height: 30 });
  const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
  const oldUri = process.env.CUTE_SSH_URI, oldPassword = process.env.CUTE_PAIRING;
  const password = "0123456789abcdef0123456789abcdef";
  process.env.CUTE_SSH_URI = "ssh://pocket@127.0.0.1:2222";
  process.env.CUTE_PAIRING = password;
  try {
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    app.share(); await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex(line => line.includes(password));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(password);
    await setup.mockMouse.pressDown(x, y);
    expect(copy).not.toHaveBeenCalled();
    await setup.mockMouse.moveTo(x + password.length - 1, y);
    expect(copy).not.toHaveBeenCalled();
    await setup.mockMouse.release(x + password.length - 1, y);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(password);
    copy.mockClear();
    await setup.mockMouse.click(x + password.length + 2, y);
    expect(copy).not.toHaveBeenCalled();
    await setup.mockMouse.doubleClick(x + 5, y);
    expect(copy).toHaveBeenLastCalledWith(password);
    setup.renderer.destroy();
    expect(setup.renderer.listenerCount("selection")).toBe(0);
  } finally {
    if (oldUri === undefined) delete process.env.CUTE_SSH_URI; else process.env.CUTE_SSH_URI = oldUri;
    if (oldPassword === undefined) delete process.env.CUTE_PAIRING; else process.env.CUTE_PAIRING = oldPassword;
    copy.mockRestore(); setup.renderer.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inline search keeps results visible, accepts Enter, and clears on Escape", async () => {
  const directory = await fixture();
  const setup = await createTestRenderer({ width: 110, height: 30 });
  try {
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    setup.mockInput.pressKey("/"); await setup.renderOnce();
    const input = setup.renderer.root.findDescendantById("search") as InputRenderable;
    expect(setup.renderer.root.findDescendantById("dialog")).toBeUndefined();
    expect(input.visible).toBe(true);
    expect(input.height).toBe(1);
    expect(input.y).toBeLessThan(app.list.y);
    expect(setup.captureCharFrame()).toContain("folder/");
    expect(setup.captureCharFrame()).toContain("hello.txt");
    await setup.mockInput.typeText("hello");
    await setup.waitForFrame(frame => frame.includes("Hello, pocket!"));
    expect(input.focused).toBe(true);
    expect(app.list.options.length).toBe(1);
    setup.resize(54, 18); await setup.renderOnce();
    expect(input.y).toBeLessThan(app.list.y);
    expect(setup.captureCharFrame()).toContain("hello.txt");
    setup.mockInput.pressEnter(); await setup.renderOnce();
    expect(input.visible).toBe(false);
    expect(app.list.focused).toBe(true);
    expect(app.list.options.length).toBe(1);
    setup.mockInput.pressKey("/");
    expect(input.value).toBe("hello");
    await setup.mockInput.typeText("n?qs"); await setup.renderOnce();
    expect(app.list.options.length).toBe(0);
    expect(setup.renderer.root.findDescendantById("dialog")).toBeUndefined();
    expect(setup.renderer.isDestroyed).toBe(false);
    setup.mockInput.pressEscape(); await Bun.sleep(60); await setup.renderOnce();
    expect(input.visible).toBe(false);
    expect(app.list.focused).toBe(true);
    expect(app.list.options.length).toBe(2);
    expect(setup.captureCharFrame()).toContain("folder/");
    setup.mockInput.pressTab();
    setup.mockInput.pressKey("/"); await setup.renderOnce();
    expect(input.visible).toBe(true);
    expect(input.focused).toBe(true);
    expect(input.value).toBe("");
    expect(setup.captureCharFrame()).toContain("folder/");
  } finally { setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("bookmark toggles persist and support keyboard and sidebar jumps", async () => {
  const directory = await fixture(), folder = join(directory, "folder");
  const database = join(directory, ".bookmarks.sqlite");
  const setup = await createTestRenderer({ width: 110, height: 30 });
  let reopened: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
  try {
    const app = buildApp(setup.renderer, directory, database); await app.ready;
    setup.mockInput.pressKey("b"); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("No bookmarks yet");
    expect(setup.renderer.root.findDescendantById("dialog")!.height).toBe(6);
    setup.mockInput.pressEscape(); await Bun.sleep(60);
    setup.mockInput.pressKey("B"); await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("bookmark-0")).toBeDefined();
    expect(setup.captureCharFrame()).toContain("unbookmark B");
    setup.mockInput.pressKey("B"); await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("bookmark-0")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("Removed bookmark");
    expect(await Bun.file(join(directory, "hello.txt")).exists()).toBe(true);
    setup.mockInput.pressKey("B");
    setup.mockInput.pressKey("b"); await setup.renderOnce();
    let picker = setup.renderer.root.findDescendantById("bookmark-picker") as SelectRenderable;
    expect(picker.options.length).toBe(1);
    expect(setup.renderer.root.findDescendantById("dialog")!.height).toBe(4);
    setup.mockInput.pressEscape(); await Bun.sleep(60);
    await app.load(folder); setup.mockInput.pressKey("B"); await app.load(directory);
    setup.mockInput.pressKey("b"); await setup.renderOnce();
    picker = setup.renderer.root.findDescendantById("bookmark-picker") as SelectRenderable;
    expect(picker.options.map(option => option.value)).toEqual([directory, folder]);
    picker.setSelectedIndex(1); setup.mockInput.pressEnter(); await Bun.sleep(40);
    expect(app.cwd).toBe(folder);
    expect(setup.renderer.root.findDescendantById("dialog")).toBeUndefined();
    await setup.renderOnce();
    const saved = setup.renderer.root.findDescendantById("bookmark-0")!;
    await setup.mockMouse.click(saved.x + 2, saved.y); await Bun.sleep(40);
    expect(app.cwd).toBe(directory);
    setup.renderer.destroy();
    reopened = await createTestRenderer({ width: 54, height: 18 });
    let next = buildApp(reopened.renderer, directory, database); await next.ready;
    reopened.mockInput.pressKey("b"); await reopened.renderOnce();
    picker = reopened.renderer.root.findDescendantById("bookmark-picker") as SelectRenderable;
    expect(picker.options.map(option => option.value)).toEqual([directory, folder]);
    reopened.resize(54, 12); await reopened.renderOnce();
    expect(reopened.renderer.root.findDescendantById("dialog")!.height).toBe(5);
    await reopened.mockMouse.click(picker.x + 2, picker.y + 1); await Bun.sleep(40);
    expect(next.cwd).toBe(folder);
    reopened.mockInput.pressKey("B");
    reopened.renderer.destroy();
    reopened = await createTestRenderer({ width: 54, height: 12 });
    next = buildApp(reopened.renderer, directory, database); await next.ready;
    reopened.mockInput.pressKey("b"); await reopened.renderOnce();
    picker = reopened.renderer.root.findDescendantById("bookmark-picker") as SelectRenderable;
    expect(picker.options.map(option => option.value)).toEqual([directory]);
    reopened.mockInput.pressEscape(); await Bun.sleep(60);
    await next.load(folder); reopened.mockInput.pressKey("B"); await next.load(directory);
    await rename(folder, join(directory, "moved-folder"));
    reopened.mockInput.pressKey("b"); await reopened.renderOnce();
    picker = reopened.renderer.root.findDescendantById("bookmark-picker") as SelectRenderable;
    picker.setSelectedIndex(1); reopened.mockInput.pressEnter(); await Bun.sleep(40); await reopened.renderOnce();
    expect(next.cwd).toBe(directory);
    expect(reopened.renderer.root.findDescendantById("dialog")).toBeDefined();
    expect(reopened.captureCharFrame()).toContain("ENOENT");
  } finally {
    setup.renderer.destroy(); reopened?.renderer.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("x queues a cut, p moves safely and clears it, and y still copies repeatedly", async () => {
  const directory = await fixture(), source = join(directory, "hello.txt"), folder = join(directory, "folder");
  const setup = await createTestRenderer({ width: 110, height: 30 });
  async function paste(message: string) {
    setup.mockInput.pressKey("p");
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(10); await setup.renderOnce();
      if (setup.captureCharFrame().includes(message)) return;
    }
    throw new Error(`Paste did not report: ${message}`);
  }
  try {
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    app.list.setSelectedIndex(app.list.options.findIndex(option => option.value.path === source));
    setup.mockInput.pressKey("x"); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Cut hello.txt");
    expect(await Bun.file(source).text()).toContain("Hello, pocket!");
    await paste("Choose a different folder");
    const target = join(folder, "hello.txt");
    await Bun.write(target, "keep this content"); await app.load(folder);
    await paste("That name already exists");
    expect(await Bun.file(source).text()).toContain("Hello, pocket!");
    expect(await Bun.file(target).text()).toBe("keep this content");
    await rename(target, join(folder, "occupied.txt"));
    await paste("Move pasted.");
    expect(await Bun.file(source).exists()).toBe(false);
    expect(await Bun.file(target).text()).toContain("Hello, pocket!");
    expect(app.list.getSelectedOption()?.value.path).toBe(target);
    await paste("Press y or x on a file first");
    setup.mockInput.pressKey("x"); setup.mockInput.pressKey("y");
    await app.load(directory); await paste("Copy pasted.");
    expect(await Bun.file(target).text()).toContain("Hello, pocket!");
    expect(await Bun.file(source).text()).toContain("Hello, pocket!");
    const another = await create(directory, "another", true);
    await app.load(another); await paste("Copy pasted.");
    expect(await Bun.file(join(another, "hello.txt")).text()).toContain("Hello, pocket!");
    expect(await Bun.file(target).exists()).toBe(true);
  } finally { setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("trash uses a centered Cancel-first confirmation with keyboard, mouse and failure recovery", async () => {
  const directory = await fixture(), source = join(directory, "hello.txt");
  const setup = await createTestRenderer({ width: 110, height: 30 });
  const gio = join(directory, "bin", "gio"), spawn = Bun.spawn;
  const which = spyOn(Bun, "which").mockReturnValue(gio);
  const launch = spyOn(Bun, "spawn").mockImplementation((command: unknown) => {
    if (!Array.isArray(command) || command[0] !== "gio") throw new Error("Unexpected subprocess in trash test.");
    return spawn([gio, ...command.slice(1)], { stdout: "ignore", stderr: "pipe" });
  });
  async function waitFor(check: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(10); await setup.renderOnce(); if (await check()) return;
    }
    throw new Error("Trash confirmation did not finish.");
  }
  try {
    const bin = join(directory, "bin"), trash = join(directory, "trash"), calls = join(directory, "calls"), fail = join(directory, "fail");
    await mkdir(bin); await mkdir(trash); await Bun.write(fail, "fail");
    await Bun.write(gio, `#!/bin/sh
root=$(dirname -- "$(dirname -- "$0")")
printf '%s\\n' "$@" >> "$root/calls"
if [ -e "$root/fail" ]; then printf 'Trash failed\\n' >&2; exit 1; fi
mv -- "$3" "$root/trash/"
`);
    await chmod(gio, 0o700);
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    app.list.setSelectedIndex(app.list.options.findIndex(option => option.value.path === source));
    setup.mockInput.pressKey("d"); await setup.renderOnce();
    const modal = setup.renderer.root.findDescendantById("dialog")!;
    let choices = setup.renderer.root.findDescendantById("confirm-choices") as TabSelectRenderable;
    expect(modal.height).toBe(6); expect(modal.width).toBe(60);
    expect(modal.x).toBe(25); expect(modal.y).toBe(12);
    expect(choices.getSelectedIndex()).toBe(0);
    expect(setup.renderer.root.findDescendantById("dialog-input")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain('Move "hello.txt"');
    await setup.waitForFrame(frame => frame.includes("Restore with your desktop file manager"));
    await setup.mockMouse.click(app.list.x + 1, app.list.y + 1);
    setup.mockInput.pressEnter();
    expect(setup.renderer.root.findDescendantById("dialog")).toBeUndefined();
    expect(await Bun.file(calls).exists()).toBe(false);
    expect(await Bun.file(source).exists()).toBe(true);
    setup.mockInput.pressKey("d"); setup.mockInput.pressEscape(); await Bun.sleep(60);
    expect(setup.renderer.root.findDescendantById("dialog")).toBeUndefined();
    setup.mockInput.pressKey("d"); await setup.renderOnce();
    choices = setup.renderer.root.findDescendantById("confirm-choices") as TabSelectRenderable;
    await setup.mockMouse.click(choices.x + 1, choices.y);
    expect(setup.renderer.root.findDescendantById("dialog")).toBeUndefined();
    expect(await Bun.file(calls).exists()).toBe(false);
    setup.mockInput.pressKey("d"); await setup.renderOnce();
    choices = setup.renderer.root.findDescendantById("confirm-choices") as TabSelectRenderable;
    setup.mockInput.pressTab({ shift: true }); expect(choices.getSelectedIndex()).toBe(1);
    setup.mockInput.pressArrow("left"); expect(choices.getSelectedIndex()).toBe(0);
    setup.mockInput.pressTab(); expect(choices.getSelectedIndex()).toBe(1);
    setup.resize(40, 14); await setup.renderOnce();
    expect(choices.width).toBeLessThanOrEqual(36);
    expect(setup.renderer.root.findDescendantById("dialog")!.x).toBe(1);
    setup.mockInput.pressEnter();
    await waitFor(() => setup.captureCharFrame().includes("Trash failed"));
    expect(setup.renderer.root.findDescendantById("dialog")).toBeDefined();
    expect(await Bun.file(source).exists()).toBe(true);
    expect((await Bun.file(calls).text()).trim().split("\n")).toEqual(["trash", "--", source]);
    await rename(fail, join(directory, "disabled"));
    setup.mockInput.pressEnter();
    await waitFor(() => !setup.renderer.root.findDescendantById("dialog"));
    expect(await Bun.file(source).exists()).toBe(false);
    expect(await Bun.file(join(trash, "hello.txt")).text()).toContain("Hello, pocket!");
    const mouseFile = join(directory, "mouse.txt"); await Bun.write(mouseFile, "mouse confirmation");
    await app.load(directory, mouseFile); setup.mockInput.pressKey("d"); await setup.renderOnce();
    choices = setup.renderer.root.findDescendantById("confirm-choices") as TabSelectRenderable;
    await setup.mockMouse.click(choices.x + choices.tabWidth + 1, choices.y);
    await waitFor(() => !setup.renderer.root.findDescendantById("dialog"));
    expect(await Bun.file(mouseFile).exists()).toBe(false);
    expect(await Bun.file(join(trash, "mouse.txt")).text()).toBe("mouse confirmation");
  } finally {
    launch.mockRestore(); which.mockRestore();
    setup.renderer.destroy(); await rm(directory, { recursive: true, force: true });
  }
});

test("new file, new folder, rename and go-to prompts are compact, centered and keep validation", async () => {
  const directory = await fixture();
  const setup = await createTestRenderer({ width: 110, height: 30 });
  try {
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    app.list.setSelectedIndex(app.list.options.findIndex(option => option.value.name === "hello.txt"));
    for (const key of ["n", "N", "r", "g"]) {
      setup.mockInput.pressKey(key); await setup.renderOnce();
      const modal = setup.renderer.root.findDescendantById("dialog")!;
      const input = setup.renderer.root.findDescendantById("dialog-input") as InputRenderable;
      expect(modal.height).toBe(6); expect(modal.width).toBe(60);
      expect(modal.x).toBe(25); expect(modal.y).toBe(12);
      expect(input.focused).toBe(true);
      expect(input.y).toBeLessThan(modal.y + modal.height - 2);
      setup.resize(54, 18); await setup.renderOnce();
      expect(modal.width).toBe(52); expect(modal.x).toBe(1); expect(modal.y).toBe(6);
      setup.mockInput.pressEscape(); await Bun.sleep(60); setup.resize(110, 30);
    }
    setup.mockInput.pressKey("n"); setup.mockInput.pressEnter(); await Bun.sleep(20); await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("dialog")).toBeDefined();
    expect(setup.captureCharFrame()).toContain("Use a single file name");
    setup.mockInput.pressEscape(); await Bun.sleep(60);
    app.help(); await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("dialog")!.height).toBe(30);
    expect(setup.renderer.root.findDescendantById("dialog")!.x).toBe(0);
    app.share(); await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("dialog")!.height).toBe(30);
  } finally { setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }); }
});
