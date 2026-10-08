import {
  BoxRenderable, TextRenderable, SelectRenderable, SelectRenderableEvents,
  InputRenderable, InputRenderableEvents, ScrollBoxRenderable, ImageRenderable,
  type CliRenderer, type KeyEvent, bold, fg, t,
} from "@opentui/core";
import { QRCodeRenderable } from "@opentui/qrcode";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { entries, clean, kind, size, textPreview, musicPreview, create, renameEntry, copyInto, type Entry } from "./files";

const C = { bg: "#202923", panel: "#25312a", ink: "#f5ead7", muted: "#acb9a7", mint: "#a8d5b5", peach: "#efb896", line: "#526854", selected: "#455d49", error: "#f2a799" };
const label = (text: string) => clean(text).replace(/[\r\n\t]/g, "�");
const icon = (entry: Entry) => entry.directory ? "+" : kind(entry.path) === "music" ? "♪" : kind(entry.path) === "image" ? "▧" : "·";

export function buildApp(renderer: CliRenderer, initialPath: string) {
  let cwd = resolve(initialPath), all: Entry[] = [], hidden = false, query = "", busy = false;
  let previewVersion = 0, loadVersion = 0, disposed = false, clipboard: string | undefined;
  let modal: BoxRenderable | undefined, prompt: InputRenderable | undefined;
  let modalMessage: TextRenderable | undefined;
  let previewFocused = false, previewReady = false;
  let player: ReturnType<typeof Bun.spawn> | undefined;
  let playingPath: string | undefined;
  const app = new BoxRenderable(renderer, { id: "app", width: "100%", height: "100%", flexDirection: "column", backgroundColor: C.bg });
  renderer.root.add(app);
  const header = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: t`${bold(fg(C.peach)(" (=^･ω･^=)  pocket"))}  ${fg(C.muted)("a little home for your files")}`, bg: C.bg });
  app.add(header);
  const breadcrumb = new TextRenderable(renderer, { height: 1, flexShrink: 0, fg: C.mint });
  app.add(breadcrumb);
  const body = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "row" });
  app.add(body);
  const places = new BoxRenderable(renderer, { width: 19, flexShrink: 0, border: true, borderStyle: "rounded", borderColor: C.line, title: " places ", titleColor: C.peach, flexDirection: "column" });
  body.add(places);
  for (const [label, path] of [["⌂  Home", homedir()], ["↓  Downloads", join(homedir(), "Downloads")], ["▤  Documents", join(homedir(), "Documents")], ["/  Filesystem", "/"], ["·  Started here", cwd]] as const) {
    places.add(new TextRenderable(renderer, { content: ` ${label}`, height: 1, fg: C.muted, onMouseDown: () => { if (!modal && !busy) run(() => load(path)); } }));
  }
  places.add(new BoxRenderable(renderer, { flexGrow: 1 }));
  places.add(new TextRenderable(renderer, { content: "  /\\_/\\\n ( o.o )\n  > ^ <\n\n ?  all shortcuts\n s  share session", fg: C.peach, flexShrink: 0 }));
  const listPanel = new BoxRenderable(renderer, { flexGrow: 1, flexBasis: 0, minWidth: 0, border: true, borderStyle: "rounded", borderColor: C.mint, title: " files ", titleColor: C.mint, flexDirection: "column" });
  body.add(listPanel);
  const searchInput = new InputRenderable(renderer, {
    id: "search", visible: false, flexShrink: 0,
    placeholder: "Filter file names…", textColor: C.ink,
    backgroundColor: C.selected, focusedBackgroundColor: C.selected, cursorColor: C.peach,
  });
  listPanel.add(searchInput);
  searchInput.on(InputRenderableEvents.INPUT, (value: string) => { query = value; filter(); });
  searchInput.on(InputRenderableEvents.ENTER, () => finishSearch(false));
  const list = new SelectRenderable(renderer, {
    id: "files", flexGrow: 1, minHeight: 0, showDescription: false, showScrollIndicator: true,
    options: [], textColor: C.ink, backgroundColor: C.bg, focusedBackgroundColor: C.bg,
    focusedTextColor: C.ink, selectedBackgroundColor: C.selected, selectedTextColor: C.ink,
    onMouseDown: (event) => {
      if (modal || busy) return;
      previewFocused = false; layout(); list.focus();
      // Select has keyboard scrolling but no built-in pointer selection.
      const selected = list.getSelectedIndex();
      const rows = Math.max(1, list.height);
      const offset = Math.max(0, Math.min(selected - Math.floor(rows / 2), list.options.length - rows));
      const index = offset + event.y - list.y;
      if (index >= 0 && index < list.options.length) list.setSelectedIndex(index);
    },
  });
  listPanel.add(list);
  const previewPanel = new BoxRenderable(renderer, { id: "preview", width: "48%", minWidth: 0, border: true, borderStyle: "rounded", borderColor: C.line, title: " peek inside ", titleColor: C.peach, flexDirection: "column", backgroundColor: C.panel,
    onMouseDown: () => {
      if (modal || busy) return;
      previewFocused = true; preview.focus(); layout();
      listPanel.borderColor = C.line; previewPanel.borderColor = C.mint;
    },
  });
  body.add(previewPanel);
  const metadata = new TextRenderable(renderer, { fg: C.muted, flexShrink: 0, wrapMode: "word" });
  previewPanel.add(metadata);
  const preview = new ScrollBoxRenderable(renderer, { flexGrow: 1, minHeight: 0, scrollX: true, scrollY: true });
  previewPanel.add(preview);
  const previewText = new TextRenderable(renderer, { fg: C.ink, wrapMode: "none", content: "Choose a file to take a peek." });
  preview.add(previewText);
  const image = new ImageRenderable(renderer, { id: "preview-image", flexGrow: 1, minHeight: 0, fit: "fit", protocol: "auto", visible: false, onError: (error) => { if (!disposed) { image.visible = false; preview.visible = true; previewText.content = `Image preview failed: ${clean(String(error))}`; } } });
  previewPanel.add(image);
  const status = new TextRenderable(renderer, { height: 1, flexShrink: 0, fg: C.muted, content: "Welcome home. Enter opens, e edits, ? helps." });
  app.add(status);
  const toolbar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: C.selected });
  app.add(toolbar);
  for (const [label, action] of [
    [" Enter open ", () => openSelected()], [" e edit ", () => edit()],
    [" / find ", () => search()], [" n new ", () => newEntry(false)],
    [" s SSH ", () => share()], [" ? help ", () => help()],
  ] as const) toolbar.add(new TextRenderable(renderer, { content: label, fg: C.ink, onMouseDown: () => { if (!modal && !busy) run(action); } }));

  function say(message: string, error = false) {
    if (disposed) return;
    status.content = clean(message); status.fg = error ? C.error : C.muted;
    if (error && modalMessage) { modalMessage.content = ` ${clean(message)}`; modalMessage.fg = C.error; }
  }
  function run(action: () => void | Promise<unknown>) {
    const fail = (error: unknown) => say(error instanceof Error ? error.message : String(error), true);
    try { Promise.resolve(action()).catch(fail); } catch (error) { fail(error); }
  }
  function selected(): Entry | undefined { return list.getSelectedOption()?.value; }
  function layout() {
    places.visible = renderer.width >= 100;
    const narrow = renderer.width < 72;
    listPanel.visible = !narrow || !previewFocused;
    previewPanel.visible = !narrow || previewFocused;
    previewPanel.width = narrow ? "100%" : "48%";
    if (modal) { modal.width = Math.max(20, Math.min(76, renderer.width - 2)); modal.height = Math.min(34, renderer.height); }
  }
  renderer.on("resize", layout);
  layout();

  async function load(path: string, selectPath?: string) {
    const version = ++loadVersion;
    const items = await entries(path);
    if (disposed || version !== loadVersion) return;
    cwd = resolve(path); all = items; query = "";
    if (searchInput.visible) finishSearch(false);
    breadcrumb.content = ` ${clean(cwd.replace(homedir(), "~"))}`;
    filter(selectPath);
  }
  function filter(selectPath?: string) {
    const visible = all.filter(entry => (hidden || !entry.name.startsWith(".")) && entry.name.toLowerCase().includes(query.toLowerCase()));
    list.options = visible.map(entry => ({ name: ` ${icon(entry)}  ${label(entry.name)}${entry.directory ? "/" : ""}${entry.link ? " ↗" : ""}`, description: "", value: entry }));
    listPanel.bottomTitle = ` ${visible.length} items${hidden ? " · hidden shown" : ""}${query ? ` · ${clean(query)}` : ""} `;
    list.setSelectedIndex(Math.max(0, visible.findIndex(entry => entry.path === selectPath)));
    if (!visible.length) void refreshPreview();
  }
  async function refreshPreview() {
    const version = ++previewVersion, entry = selected();
    previewReady = false;
    image.source = undefined; image.visible = false; preview.visible = true; preview.scrollTo(0);
    previewText.content = entry ? "Taking a peek…" : "No matching files. Esc clears your filter.";
    metadata.content = "";
    if (!entry) return;
    try {
      const info = await stat(entry.path);
      if (disposed || version !== previewVersion) return;
      metadata.content = `${label(entry.name)}\n${entry.directory ? "Folder" : size(info.size)} · ${info.mtime.toLocaleDateString()}\n`;
      if (entry.directory) {
        const children = await entries(entry.path);
        if (disposed || version !== previewVersion) return;
        previewText.content = `${children.length} items\n\n${children.slice(0, 150).map(child => `${icon(child)}  ${label(child.name)}${child.directory ? "/" : ""}`).join("\n")}${children.length > 150 ? "\n…" : ""}\n\nEnter to step inside.`;
      } else if (kind(entry.path) === "image") {
        if (info.size > 32 * 1024 ** 2) { previewText.content = "Image exceeds the 32 MB preview limit."; return; }
        preview.visible = false; image.visible = true; image.source = entry.path;
      } else {
        const content = await (kind(entry.path) === "music" ? musicPreview(entry.path) : textPreview(entry.path));
        if (!disposed && version === previewVersion) previewText.content = content;
      }
      if (!disposed && version === previewVersion) previewReady = true;
    } catch (error) { if (!disposed && version === previewVersion) previewText.content = `Cannot preview: ${clean(String(error))}`; }
  }
  list.on(SelectRenderableEvents.SELECTION_CHANGED, () => run(refreshPreview));
  list.on(SelectRenderableEvents.ITEM_SELECTED, () => run(openSelected));

  async function openSelected() {
    if (busy || modal) return;
    const entry = selected();
    if (!entry) return;
    if (entry.directory) await load(entry.path);
    else if (kind(entry.path) === "music") toggleMusic();
    else if (kind(entry.path) === "image") { previewFocused = true; preview.focus(); layout(); say("Tab returns to files. Image uses blocks inside tmux."); }
    else await edit();
  }
  function copyText(text: string, source: string) {
    const copied = renderer.copyToClipboardOSC52(text);
    say(copied ? `${source} sent to your terminal clipboard.` : "Terminal clipboard unavailable. Enable OSC 52 in your terminal.", !copied);
  }
  function copySelection() {
    const text = renderer.getSelection()?.getSelectedText();
    if (text) copyText(text, "Selected text");
  }
  function copyPreview() {
    if (image.visible) { say("Image previews cannot be copied as text.", true); return; }
    if (!previewReady) { say("No preview text ready to copy.", true); return; }
    copyText(previewText.plainText, "Preview text");
  }
  async function edit() {
    const entry = selected();
    if (!entry || entry.directory || busy) return;
    busy = true;
    player?.kill(); player = undefined; playingPath = undefined;
    renderer.suspend();
    try {
      // EDITOR is trusted local configuration. File names are a positional argument, never shell code.
      const child = Bun.spawn(["sh", "-c", `exec ${process.env.EDITOR || "vi"} "$1"`, "pocket-editor", entry.path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      const code = await child.exited;
      say(code ? `Editor exited with status ${code}.` : `Back from the editor. ${entry.name}` , code !== 0);
    } finally { renderer.resume(); busy = false; list.focus(); await load(cwd, entry.path); }
  }
  function toggleMusic() {
    if (player) { player.kill(); player = undefined; playingPath = undefined; say("Playback stopped."); return; }
    const entry = selected();
    if (!entry || entry.directory || kind(entry.path) !== "music") return;
    if (!Bun.which("ffplay")) throw new Error("Install ffmpeg to play audio with ffplay.");
    const child = Bun.spawn(["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", entry.path], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    player = child; playingPath = entry.path;
    say(`♪ Playing ${entry.name} on the host. Space stops.`);
    const errors = new Response(child.stderr).text();
    void child.exited.then(async code => {
      if (player !== child) return;
      player = undefined; playingPath = undefined;
      say(code ? `Playback failed: ${(await errors).slice(0, 200)}` : "Playback finished.", code !== 0);
    });
  }

  function closeModal() {
    if (!modal) return;
    const closing = modal; modal = undefined; prompt = undefined; modalMessage = undefined;
    closing.destroyRecursively();
    list.focus();
  }
  function dialog(title: string, content: string) {
    if (searchInput.visible) finishSearch(false);
    closeModal(); list.blur(); preview.blur();
    modal = new BoxRenderable(renderer, { id: "dialog", position: "absolute", top: 0, left: 0, width: Math.max(20, Math.min(76, renderer.width - 2)), height: Math.min(34, renderer.height), zIndex: 50, border: true, borderStyle: "rounded", borderColor: C.peach, title: ` ${title} `, titleColor: C.peach, backgroundColor: C.panel, flexDirection: "column" });
    app.add(modal);
    const scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, minHeight: 0 });
    modal.add(scroll);
    if (content) scroll.add(new TextRenderable(renderer, { content, fg: C.ink, wrapMode: "word" }));
    scroll.focus();
    modalMessage = new TextRenderable(renderer, { content: " Esc close", height: 1, fg: C.peach, onMouseDown: closeModal });
    modal.add(modalMessage);
    return scroll;
  }
  function ask(title: string, description: string, value: string, action: (value: string) => Promise<unknown>) {
    dialog(title, description);
    prompt = new InputRenderable(renderer, { value, placeholder: "Type here, Enter confirms", textColor: C.ink, backgroundColor: C.selected, focusedBackgroundColor: C.selected, cursorColor: C.peach });
    modal!.add(prompt);
    prompt.on(InputRenderableEvents.ENTER, (answer: string) => {
      if (busy) return;
      busy = true;
      run(async () => { try { await action(answer); closeModal(); } finally { busy = false; } });
    });
    prompt.focus();
  }
  function search() {
    previewFocused = false; layout();
    listPanel.borderColor = C.mint; previewPanel.borderColor = C.line;
    searchInput.value = query; searchInput.visible = true; searchInput.focus();
    say("Type to filter file names. Enter keeps the filter; Esc clears it.");
  }
  function finishSearch(clear: boolean) {
    searchInput.visible = false;
    if (clear) { query = ""; filter(); }
    list.focus();
    say(query ? `Filter: ${query}. / changes it, Esc clears it.` : "Search closed.");
  }
  function newEntry(folder: boolean) {
    ask(folder ? "New folder" : "New file", "Existing files are never overwritten.", "", async name => {
      const path = await create(cwd, name, folder); await load(cwd, path); say(`Created ${name}.`);
    });
  }
  function renameSelected() {
    const entry = selected(); if (!entry) return;
    ask("Rename", `Rename ${clean(entry.name)}. Existing names are protected.`, entry.name, async name => {
      const path = await renameEntry(entry.path, name); await load(cwd, path); say(`Renamed to ${name}.`);
    });
  }
  function trashSelected() {
    const entry = selected(); if (!entry) return;
    ask("Move to trash", `Move ${clean(entry.name)} to the system trash?\nType trash to confirm. Restore it with your desktop file manager.`, "", async answer => {
      if (answer !== "trash") throw new Error("Type trash to confirm, or Esc to cancel.");
      if (!Bun.which("gio")) throw new Error("System trash needs gio. Nothing was removed.");
      const child = Bun.spawn(["gio", "trash", "--", entry.path], { stdout: "ignore", stderr: "pipe" });
      const error = await new Response(child.stderr).text();
      if (await child.exited) throw new Error(error || "Could not move to trash.");
      await load(cwd); say(`Moved ${entry.name} to trash.`);
    });
  }
  function help() {
    dialog("A tiny field guide", `FILES\n↑ ↓ or j k  choose a file\nEnter / → / l  open folder or file\n← / h / Backspace  parent folder\nTab  files / preview, arrows scroll preview\nEnter in preview  copy displayed text to clipboard\nDrag over text  copy selection when released\n/  find in this folder    Esc  clear filter\n.  show hidden files     g  go to a path\nHome  first file         End  last file\n\nMAKE & EDIT\ne  edit with $EDITOR, defaults to vi\nn  new file             N  new folder\nr  rename               y  copy selected file or folder\np  paste a copy, no overwrite\nd  move to system trash, confirmation required\nSpace  play / stop music on the host\nF5  refresh folder\n\nSHARED SESSION\ns  SSH connection and QR code\nCtrl+B then %  split left / right\nCtrl+B then \"  split top / bottom\nCtrl+B then c  new shell tab\nCtrl+B then arrows  switch panes\nCtrl+B then n / p  next / previous tab\nCtrl+B then d  detach, leave session running\n\n?  this guide    q  close file manager\nSSH users share control and your OS permissions.`);
  }
  function share() {
    const uri = process.env.CUTE_SSH_URI;
    if (!uri) { dialog("Share this pocket", "Start with bun run start to create a Rust SSH server and a shared tmux session.\n\nFor another device on your LAN:\nbun run start --listen 0.0.0.0:2222 --host YOUR_LAN_IP\n\nThen press s here."); return; }
    const scroll = dialog("Join the same pocket", "");
    modal!.width = Math.min(96, renderer.width - 2);
    const content = new BoxRenderable(renderer, { flexDirection: renderer.width >= 85 ? "row" : "column", width: "100%" });
    scroll.add(content);
    content.add(new QRCodeRenderable(renderer, { content: uri, quietZone: 4, scale: 1, fit: "contain", flexShrink: 0, foregroundColor: "#000000", backgroundColor: "#ffffff", fallbackContent: "Resize terminal for QR" }));
    content.add(new TextRenderable(renderer, { flexGrow: 1, minWidth: 0, wrapMode: "word", fg: C.ink, content: `${uri}\n\n${process.env.CUTE_SSH_COMMAND}\n\nPairing password for this server run:\n${process.env.CUTE_PAIRING}\n\nHost key fingerprint:\n${process.env.CUTE_FINGERPRINT}\n\nScan with an SSH app that understands ssh:// links. Verify the fingerprint before entering the password.\n\nTrusted users can edit files and run shells as you. Audio plays on the host. Esc hides these credentials.` }));
  }
  function onKey(key: KeyEvent) {
    if (busy) { key.preventDefault(); return; }
    if (modal) { if (key.name === "escape") { key.preventDefault(); closeModal(); } return; }
    if (searchInput.focused) {
      if (key.name === "escape" || key.name === "tab") {
        key.preventDefault(); finishSearch(key.name === "escape");
      }
      return;
    }
    if (key.ctrl || key.meta || key.super) return;
    if (key.name === "tab") {
      key.preventDefault(); previewFocused = !previewFocused;
      if (previewFocused) preview.focus(); else list.focus();
      listPanel.borderColor = previewFocused ? C.line : C.mint;
      previewPanel.borderColor = previewFocused ? C.mint : C.line;
      layout(); return;
    }
    if (key.name === "escape") { searchInput.visible = false; query = ""; filter(); previewFocused = false; list.focus(); layout(); key.preventDefault(); return; }
    if (key.name === "q") { renderer.destroy(); return; }
    if (key.name === "?" || key.sequence === "?") { help(); key.preventDefault(); return; }
    const globalAction = key.name === "/" ? search : key.name === "s" ? share : key.name === "e" ? edit : key.name === "space" ? toggleMusic : undefined;
    if (globalAction) { key.preventDefault(); run(globalAction); return; }
    if (previewFocused) {
      if (key.name === "return") { key.preventDefault(); copyPreview(); }
      return;
    }
    const actions: Record<string, () => void | Promise<unknown>> = {
      e: edit, "/": search, n: () => newEntry(key.shift), N: () => newEntry(true), r: renameSelected, d: trashSelected,
      s: share, ".": () => { hidden = !hidden; filter(); },
      g: () => ask("Go to folder", "Absolute or relative path. ~ means your home.", cwd, async path => load(resolve(cwd, path.replace(/^~(?=\/|$)/, homedir())))),
      y: () => { clipboard = selected()?.path; say(clipboard ? `Copied ${basename(clipboard)}. Go to a folder and press p.` : "No file selected."); },
      p: async () => { if (!clipboard) throw new Error("Press y on a file first."); busy = true; try { const path = await copyInto(clipboard, cwd); await load(cwd, path); say("Copy pasted."); } finally { busy = false; } },
      left: () => load(dirname(cwd), cwd), h: () => load(dirname(cwd), cwd), backspace: () => load(dirname(cwd), cwd),
      right: openSelected, l: openSelected, space: toggleMusic, f5: () => load(cwd, selected()?.path),
      home: () => list.setSelectedIndex(0), end: () => list.setSelectedIndex(list.options.length - 1),
      pagedown: () => list.moveDown(Math.max(1, list.height - 1)), pageup: () => list.moveUp(Math.max(1, list.height - 1)),
    };
    const action = actions[key.name] ?? actions[key.sequence];
    if (action) { key.preventDefault(); run(action); }
  }
  renderer.keyInput.on("keypress", onKey);
  renderer.on("selection", copySelection);
  renderer.once("destroy", () => {
    disposed = true; ++loadVersion; ++previewVersion;
    player?.kill();
    renderer.off("resize", layout); renderer.keyInput.off("keypress", onKey);
    renderer.off("selection", copySelection);
  });
  list.focus();
  const ready = load(cwd).catch(error => say(String(error), true));
  return { ready, load, list, help, share, get cwd() { return cwd; }, get playingPath() { return playingPath; } };
}
