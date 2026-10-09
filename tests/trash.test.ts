import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { buildApp } from "../src/ui";
import { restoreTrash, deleteTrash } from "../src/trash";

test("Trash supports restore, safe permanent-delete confirmation, retries, mouse and narrow layouts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-trash-ui-"));
  const setup = await createTestRenderer({ width: 110, height: 30 });
  const name = "cat 'quote' $name\n.txt", uri = `trash:///${encodeURIComponent(name)}`;
  let items = [uri, "trash:///folder"], restoreFails = true, deleteFails = true, available = true;
  const calls: string[][] = [], spawn = Bun.spawn;
  const which = spyOn(Bun, "which").mockImplementation(tool => tool === "gio" && available ? "/fake/gio" : null);
  const launch = spyOn(Bun, "spawn").mockImplementation((command: unknown) => {
    if (!Array.isArray(command) || command[0] !== "gio") throw new Error("Unexpected trash subprocess.");
    calls.push(command);
    let output = "", error = "", code = 0;
    if (command[1] === "list") output = items.join("\n") + (items.length ? "\n" : "");
    else if (command[1] === "info") output = "attributes:\n  trash::orig-path: /home/cat/original.txt\n  trash::deletion-date: 2026-10-09T12:00:00\n";
    else if (command[1] === "trash") {
      if (restoreFails) { error = "Original destination already exists"; code = 1; }
      else items = items.filter(item => item !== command.at(-1));
    } else if (command[1] === "remove") {
      if (deleteFails) { error = "Delete failed"; code = 1; }
      else items = items.filter(item => item !== command.at(-1));
    } else throw new Error("Unexpected trash operation.");
    return spawn(["sh", "-c", 'printf "%s" "$1"; printf "%s" "$2" >&2; exit "$3"', "trash-test", output, error, String(code)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  });
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 150; i++) { await Bun.sleep(10); await setup.renderOnce(); if (check()) return; }
    throw new Error(`Trash UI did not settle: ${setup.captureCharFrame()}`);
  }
  try {
    const app = buildApp(setup.renderer, directory, ":memory:"); await app.ready;
    for (const invalid of ["file:///tmp/file", "trash:///..", "trash:///%2E%2E", "trash:///parent/child", "trash:///%2Fetc", "trash:///%00file"]) {
      await expect(restoreTrash(invalid)).rejects.toThrow(); await expect(deleteTrash(invalid)).rejects.toThrow();
    }
    expect(calls.length).toBe(0);
    setup.mockInput.pressKey("t");
    await waitFor(() => !!setup.renderer.root.findDescendantById("trash-picker"));
    let picker = setup.renderer.root.findDescendantById("trash-picker") as SelectRenderable;
    expect(picker.options.map(option => option.value.uri)).toEqual([uri, "trash:///folder"]);
    await waitFor(() => setup.captureCharFrame().includes("/home/cat/original.txt"));
    setup.mockInput.pressEnter(); await waitFor(() => setup.captureCharFrame().includes("already exists"));
    expect(setup.renderer.root.findDescendantById("trash-picker")).toBeDefined();
    expect(calls.find(command => command[1] === "trash")).toEqual(["gio", "trash", "--restore", "--", uri]);
    restoreFails = false;
    const restore = setup.renderer.root.findDescendantById("trash-restore")!;
    await setup.mockMouse.click(restore.x + 1, restore.y);
    await waitFor(() => setup.captureCharFrame().includes("Restored"));
    picker = setup.renderer.root.findDescendantById("trash-picker") as SelectRenderable;
    expect(picker.options.length).toBe(1);
    setup.mockInput.pressKey("d"); await setup.renderOnce();
    let choices = setup.renderer.root.findDescendantById("confirm-choices") as TabSelectRenderable;
    expect(choices.getSelectedIndex()).toBe(0);
    expect(setup.renderer.root.findDescendantById("dialog")!.height).toBe(6);
    expect(setup.renderer.root.findDescendantById("dialog")!.x).toBe(25);
    expect(setup.captureCharFrame()).toContain("This cannot be undone");
    setup.mockInput.pressEnter();
    expect(calls.some(command => command[1] === "remove")).toBe(false);
    setup.mockInput.pressKey("t"); await waitFor(() => !!setup.renderer.root.findDescendantById("trash-picker"));
    setup.resize(54, 18); await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("trash-picker")!.height).toBe(8);
    const remove = setup.renderer.root.findDescendantById("trash-delete")!;
    await setup.mockMouse.click(remove.x + 1, remove.y); await setup.renderOnce();
    choices = setup.renderer.root.findDescendantById("confirm-choices") as TabSelectRenderable;
    expect(choices.getSelectedIndex()).toBe(0);
    expect(setup.renderer.root.findDescendantById("dialog")!.x).toBe(1);
    setup.mockInput.pressArrow("right"); setup.mockInput.pressEnter();
    await waitFor(() => setup.captureCharFrame().includes("Delete failed"));
    expect(setup.renderer.root.findDescendantById("confirm-choices")).toBeDefined();
    expect(items).toEqual(["trash:///folder"]);
    deleteFails = false; setup.mockInput.pressEnter();
    await waitFor(() => setup.captureCharFrame().includes("Permanently deleted"));
    expect(setup.renderer.root.findDescendantById("dialog")).toBeDefined();
    expect(setup.renderer.root.findDescendantById("trash-picker")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("system trash is empty");
    expect(calls.filter(command => command[1] === "remove")).toEqual([["gio", "remove", "--", "trash:///folder"], ["gio", "remove", "--", "trash:///folder"]]);
    expect(calls.flat()).not.toContain("--force");
    items = ["trash:///new-item"];
    setup.mockInput.pressKey("F5");
    await waitFor(() => !!setup.renderer.root.findDescendantById("trash-picker"));
    expect((setup.renderer.root.findDescendantById("trash-picker") as SelectRenderable).options[0]?.value.uri).toBe("trash:///new-item");
    setup.mockInput.pressEscape(); await Bun.sleep(60); available = false;
    setup.mockInput.pressKey("t"); await waitFor(() => setup.captureCharFrame().includes("needs gio"));
    expect(app.cwd).toBe(directory);
  } finally { launch.mockRestore(); which.mockRestore(); setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test.skipIf(process.env.POCKET_TRASH_TEST !== "1")("native GIO trash restores without clobbering and permanently deletes files and folders", async () => {
  const directory = await mkdtemp(join(homedir(), ".pocket-trash-native-"));
  try {
    await mkdir(join(directory, "data")); await mkdir(join(directory, "runtime"), { mode: 0o700 });
    const script = `
      import assert from "node:assert/strict";
      import {mkdir,rename} from "node:fs/promises";
      import {join,basename} from "node:path";
      const {trashEntries,restoreTrash,deleteTrash}=await import(process.env.TRASH_MODULE);
      const root=process.env.TRASH_FIXTURE;
      const file=join(root,"cat-"+basename(root)+" 'quote' $name\\n.txt"), folder=join(root,"folder-"+basename(root));
      const ownItems=async()=> (await trashEntries()).filter(item=>item.name.includes(basename(root)));
      await Bun.write(file,"restore me"); await mkdir(folder); await Bun.write(join(folder,"nested.txt"),"delete me");
      const child=Bun.spawn(["gio","trash","--",file,folder],{stdout:"ignore",stderr:"pipe"});
      const error=await new Response(child.stderr).text(); assert.equal(await child.exited,0,error);
      let items=await ownItems(); assert.equal(items.length,2);
      const item=items.find(item=>item.name.startsWith("cat")); assert(item);
      await Bun.write(file,"keep this"); await assert.rejects(()=>restoreTrash(item.uri));
      assert.equal(await Bun.file(file).text(),"keep this"); assert.equal((await ownItems()).length,2);
      await rename(file,join(root,"occupied.txt")); await restoreTrash(item.uri);
      assert.equal(await Bun.file(file).text(),"restore me");
      items=await ownItems(); assert.equal(items.length,1);
      await deleteTrash(items[0].uri); assert.equal((await ownItems()).length,0);
      assert.equal(await Bun.file(join(folder,"nested.txt")).exists(),false);
      console.log("PASS: isolated native GIO trash, collision-safe restore and recursive permanent deletion");
    `;
    const child = Bun.spawn(["dbus-run-session", "--", process.execPath, "-e", script], {
      env: { ...process.env, XDG_DATA_HOME: join(directory, "data"), XDG_RUNTIME_DIR: join(directory, "runtime"), GVFS_DISABLE_FUSE: "1", TRASH_FIXTURE: directory, TRASH_MODULE: resolve("src/trash.ts") },
      stdout: "pipe", stderr: "pipe", timeout: 20_000,
    });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0);
    expect(output).toContain("PASS: isolated native GIO trash");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
