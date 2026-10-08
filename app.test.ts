import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { buildApp } from "./ui";
import { childPath, create, copyInto, renameEntry, entries, textPreview, waveform, musicPreview } from "./files";

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
    const app = buildApp(setup.renderer, directory);
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
    const app = buildApp(setup.renderer, directory); await app.ready;
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
    const app = buildApp(setup.renderer, directory); await app.ready;
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
