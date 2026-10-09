import {
  BoxRenderable, TextRenderable, SelectRenderable, SelectRenderableEvents,
  InputRenderable, InputRenderableEvents, ScrollBoxRenderable, ImageRenderable,
  TabSelectRenderable, TabSelectRenderableEvents, CodeRenderable, LineNumberRenderable, SyntaxStyle,
  type CliRenderer, type KeyEvent, bold, fg, t,
} from "@opentui/core";
import { QRCodeRenderable } from "@opentui/qrcode";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { entries, clean, kind, isMedia, size, textPreview, BINARY_PREVIEW, openExternal, musicPreview, create, renameEntry, copyInto, moveInto, type Entry } from "./files";
import { previewFiletype } from "./syntax";
import { bookmarkPath, isRemoteBookmark, mountRemote, unmountRemote } from "./sshfs";
import { trashEntries, trashInfo, restoreTrash, deleteTrash, type TrashEntry } from "./trash";

const C = { bg: "#202923", panel: "#25312a", ink: "#f5ead7", muted: "#acb9a7", mint: "#a8d5b5", peach: "#efb896", line: "#526854", selected: "#455d49", error: "#f2a799" };
const label = (text: string) => clean(text).replace(/[\r\n\t]/g, "�");
const icon = (entry: Entry) => entry.directory ? "+" : kind(entry.path) === "music" ? "♪" : kind(entry.path) === "image" ? "▧" : "·";

export function buildApp(renderer: CliRenderer, initialPath: string, bookmarksFile = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "pocket", "bookmarks.sqlite")) {
  const mountsRoot = join(bookmarksFile === ":memory:" ? join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "pocket") : dirname(bookmarksFile), "mounts");
  let bookmarksDB: Database | undefined;
  let cwd = resolve(initialPath), all: Entry[] = [], hidden = false, query = "", busy = false;
  let previewVersion = 0, loadVersion = 0, disposed = false;
  let clipboard: { path: string; cut: boolean } | undefined;
  let modal: BoxRenderable | undefined, prompt: InputRenderable | undefined;
  let modalMessage: TextRenderable | undefined;
  let modalHeight = 34, modalCompact = false;
  let previewFocused = false;
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
  places.add(new TextRenderable(renderer, { id: "sshfs-connect", content: " ↗  Connect SSHFS c", height: 1, fg: C.mint, selectable: false, onMouseDown: event => { event.preventDefault(); if (!modal && !busy) connect(); } }));
  places.add(new TextRenderable(renderer, { id: "trash-place", content: " ×  Trash t", height: 1, fg: C.muted, selectable: false, onMouseDown: event => { event.preventDefault(); if (!modal && !busy) run(showTrash); } }));
  const bookmarkPlaces = new ScrollBoxRenderable(renderer, { id: "saved-places", flexGrow: 1, minHeight: 0 });
  places.add(bookmarkPlaces);
  places.add(new TextRenderable(renderer, { content: "  /\\_/\\\n ( o.o )\n  > ^ <\n\n ?  all shortcuts\n s  share session", fg: C.peach, flexShrink: 0 }));
  const listPanel = new BoxRenderable(renderer, { flexGrow: 1, flexBasis: 0, minWidth: 0, border: true, borderStyle: "rounded", borderColor: C.mint, title: " files ", titleColor: C.mint, flexDirection: "column" });
  body.add(listPanel);
  const searchInput = new InputRenderable(renderer, {
    id: "search", visible: false, flexShrink: 0,
    placeholder: "Filter file names…", placeholderColor: C.ink, textColor: C.ink,
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
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: C.ink }, keyword: { fg: C.peach, bold: true },
    string: { fg: C.mint }, comment: { fg: C.muted, italic: true },
    number: { fg: C.peach }, constant: { fg: C.peach }, boolean: { fg: C.peach },
    function: { fg: C.peach }, type: { fg: C.mint }, property: { fg: C.mint },
    tag: { fg: C.peach }, attribute: { fg: C.mint },
    punctuation: { fg: C.muted }, operator: { fg: C.ink },
    "markup.heading": { fg: C.peach, bold: true }, "markup.raw": { fg: C.mint },
    "markup.strong": { bold: true }, "markup.italic": { italic: true }, "markup.link": { fg: C.mint, underline: true },
  });
  for (const level of [1, 2, 3, 4, 5, 6]) syntaxStyle.registerStyle(`markup.heading.${level}`, { fg: C.peach, bold: true });
  const previewCode = new CodeRenderable(renderer, { id: "preview-code", syntaxStyle, fg: C.ink, wrapMode: "none", conceal: false });
  const codeLines = new LineNumberRenderable(renderer, { id: "preview-code-lines", target: previewCode, minWidth: 4, paddingRight: 2, fg: C.muted, visible: false });
  preview.add(codeLines);
  const image = new ImageRenderable(renderer, { id: "preview-image", flexGrow: 1, minHeight: 0, fit: "fit", protocol: "auto", visible: false, onError: (error) => { if (!disposed) { image.visible = false; preview.visible = true; previewText.content = `Image preview failed: ${clean(String(error))}`; } } });
  previewPanel.add(image);
  const status = new TextRenderable(renderer, { height: 1, flexShrink: 0, fg: C.muted, content: "Welcome home. Enter opens, e edits, ? helps." });
  app.add(status);
  const toolbar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: C.selected });
  app.add(toolbar);
  for (const [label, action] of [
    [" Enter open ", () => openHost()], [" e edit ", () => edit()],
    [" / find ", () => search()], [" n new ", () => newEntry(false)], [" b marks ", () => showBookmarks()],
    [" c connect ", () => connect()], [" s SSH ", () => share()], [" ? help ", () => help()],
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
    if (modal) {
      const width = Math.max(1, Math.min(modalCompact ? 60 : 76, renderer.width - 2));
      const height = Math.min(modalHeight, renderer.height);
      modal.width = width; modal.height = height;
      modal.left = modalCompact ? Math.floor((renderer.width - width) / 2) : 0;
      modal.top = modalCompact ? Math.floor((renderer.height - height) / 2) : 0;
      const picker = modal.findDescendantById("bookmark-picker");
      if (picker) picker.height = Math.max(1, height - 3);
      const trashPicker = modal.findDescendantById("trash-picker");
      if (trashPicker) trashPicker.height = Math.max(1, height - 10);
      const choices = modal.findDescendantById("confirm-choices") as TabSelectRenderable | undefined;
      if (choices) { choices.tabWidth = Math.max(1, Math.min(17, Math.floor((width - 2) / 2))); choices.width = choices.tabWidth * 2; }
    }
  }
  renderer.on("resize", layout);
  layout();

  async function load(path: string, selectPath?: string) {
    const version = ++loadVersion;
    if (isRemoteBookmark(path)) { say("Connecting SSHFS…"); path = await mountRemote(path, mountsRoot); }
    const items = await entries(path);
    if (disposed || version !== loadVersion) return;
    cwd = resolve(path); all = items; query = "";
    if (searchInput.visible) finishSearch(false);
    const location = bookmarkPath(cwd, mountsRoot);
    breadcrumb.content = ` ${clean(isRemoteBookmark(location) ? location : cwd.replace(homedir(), "~"))}`;
    filter(selectPath);
    run(refreshBookmarks);
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
    image.source = undefined; image.visible = false; preview.visible = true; preview.scrollTo(0);
    previewCode.filetype = undefined; previewCode.content = ""; codeLines.visible = false; previewText.visible = true;
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
        previewText.content = `${children.length} items\n\n${children.slice(0, 150).map(child => `${icon(child)}  ${label(child.name)}${child.directory ? "/" : ""}`).join("\n")}${children.length > 150 ? "\n…" : ""}\n\n→ to step inside.\n${children.length && children.every(child => !child.directory && isMedia(child.path)) ? "Enter to play this folder as a playlist." : "Enter opens the host's file manager."}`;
      } else if (kind(entry.path) === "image") {
        if (info.size > 32 * 1024 ** 2) { previewText.content = "Image exceeds the 32 MB preview limit."; return; }
        preview.visible = false; image.visible = true; image.source = entry.path;
      } else if (kind(entry.path) === "external" && !previewFiletype(entry.path)) {
        previewText.content = "Open with the host's default app.\n\nEnter or o to open.\n\nThe app appears on the host, not the SSH client.";
      } else {
        const filetype = kind(entry.path) === "music" ? undefined : previewFiletype(entry.path);
        const content = await (kind(entry.path) === "music" ? musicPreview(entry.path) : textPreview(entry.path, !filetype));
        if (!disposed && version === previewVersion) {
          if (filetype && content !== BINARY_PREVIEW) {
            previewCode.filetype = filetype; previewCode.content = content;
            previewText.visible = false; codeLines.visible = true;
          } else previewText.content = content;
        }
      }
    } catch (error) { if (!disposed && version === previewVersion) previewText.content = `Cannot preview: ${clean(String(error))}`; }
  }
  list.on(SelectRenderableEvents.SELECTION_CHANGED, () => run(refreshPreview));
  list.on(SelectRenderableEvents.ITEM_SELECTED, () => run(openHost));

  async function openSelected() {
    if (busy || modal) return;
    const entry = selected();
    if (!entry) return;
    if (entry.directory) await load(entry.path);
    else if (kind(entry.path) === "music") toggleMusic();
    else if (kind(entry.path) === "image") { previewFocused = true; preview.focus(); layout(); say("Tab returns to files. Image uses blocks inside tmux."); }
    else {
      busy = true;
      let external: boolean;
      try { external = kind(entry.path) === "external" || await textPreview(entry.path) === BINARY_PREVIEW; }
      finally { busy = false; }
      if (disposed) return;
      if (external) await openHost(entry.path); else await edit(entry);
    }
  }
  async function openHost(path = selected()?.path) {
    if (!path) { say("No file selected."); return; }
    say(`Opening ${basename(path)} in the host's default app…`);
    const count = await openExternal(path);
    say(count ? `Opened ${count}-item playlist in the host's default player.` : `Opened ${basename(path)} in the host's default app.`);
  }
  function copyText(text: string, source: string) {
    const copied = renderer.copyToClipboardOSC52(text);
    say(copied ? `${source} sent to your terminal clipboard.` : "Terminal clipboard unavailable. Enable OSC 52 in your terminal.", !copied);
  }
  function copySelection() {
    const text = renderer.getSelection()?.getSelectedText();
    if (text) copyText(text, "Selected text");
  }
  async function edit(entry = selected()) {
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
  function dialog(title: string, content: string, compact = false) {
    if (searchInput.visible) finishSearch(false);
    closeModal(); list.blur(); preview.blur(); modalCompact = compact; modalHeight = compact ? 6 : 34;
    modal = new BoxRenderable(renderer, { id: "dialog", position: "absolute", top: 0, left: 0, width: Math.max(20, Math.min(76, renderer.width - 2)), height: Math.min(34, renderer.height), zIndex: 50, border: true, borderStyle: "rounded", borderColor: C.peach, title: ` ${title} `, titleColor: C.peach, backgroundColor: C.panel, flexDirection: "column" });
    app.add(modal);
    const scroll = new ScrollBoxRenderable(renderer, { id: "dialog-content", flexGrow: 1, minHeight: 0 });
    modal.add(scroll);
    if (content) scroll.add(new TextRenderable(renderer, { content, fg: C.ink, wrapMode: "word" }));
    scroll.focus();
    modalMessage = new TextRenderable(renderer, { content: " Esc close", height: 1, fg: C.peach, onMouseDown: event => { event.preventDefault(); if (!busy) closeModal(); } });
    modal.add(modalMessage);
    layout();
    return scroll;
  }
  function ask(title: string, description: string, value: string, action: (value: string) => Promise<unknown>) {
    dialog(title, description, true);
    prompt = new InputRenderable(renderer, { id: "dialog-input", value, placeholder: "Type here, Enter confirms", placeholderColor: C.ink, textColor: C.ink, backgroundColor: C.selected, focusedBackgroundColor: C.selected, cursorColor: C.peach });
    modal!.add(prompt, 1);
    prompt.on(InputRenderableEvents.ENTER, (answer: string) => {
      if (busy) return;
      busy = true;
      run(async () => { try { await action(answer); closeModal(); } finally { busy = false; } });
    });
    prompt.focus();
  }
  function confirmAction(title: string, button: string, description: string, action: () => Promise<unknown>) {
    const scroll = dialog(title, description, true);
    const confirmation = modal;
    const choices = new TabSelectRenderable(renderer, {
      id: "confirm-choices", alignSelf: "center", showDescription: false, showUnderline: false, showScrollArrows: false, wrapSelection: true,
      options: [{ name: "Cancel", description: "", value: false }, { name: button, description: "", value: true }],
      backgroundColor: C.panel, textColor: C.ink, focusedBackgroundColor: C.panel, focusedTextColor: C.ink,
      selectedBackgroundColor: C.selected, selectedTextColor: C.ink,
      keyBindings: [{ name: "tab", action: "move-right" }, { name: "tab", shift: true, action: "move-left" }],
      onKeyDown: key => { if (key.name === "up" || key.name === "down") { key.preventDefault(); scroll.scrollBy(key.name === "up" ? -1 : 1); } },
      onMouseDown: event => {
        event.preventDefault(); if (busy || event.button !== 0) return;
        const index = Math.floor((event.x - choices.x) / choices.tabWidth);
        if (index >= 0 && index < 2) { choices.setSelectedIndex(index); choices.selectCurrent(); }
      },
    });
    choices.on(TabSelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      if (busy) return;
      if (!option.value) { closeModal(); return; }
      busy = true;
      run(async () => { try { await action(); if (modal === confirmation) closeModal(); } finally { busy = false; } });
    });
    modal!.add(choices, 1); layout(); choices.focus();
    modalMessage!.content = " ← → / Tab choose · Enter confirm · Esc cancel";
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
  function savedBookmarks() {
    if (!bookmarksDB) {
      if (bookmarksFile !== ":memory:") mkdirSync(dirname(bookmarksFile), { recursive: true, mode: 0o700 });
      bookmarksDB = new Database(bookmarksFile, { create: true, strict: true });
      bookmarksDB.exec("PRAGMA busy_timeout = 1000; CREATE TABLE IF NOT EXISTS bookmarks (path TEXT PRIMARY KEY NOT NULL) STRICT");
    }
    return bookmarksDB.query<{ path: string }, []>("SELECT path FROM bookmarks ORDER BY path COLLATE NOCASE").all().map(row => row.path);
  }
  function refreshBookmarks() {
    const paths = savedBookmarks();
    for (const child of bookmarkPlaces.getChildren()) child.destroyRecursively();
    bookmarkPlaces.add(new TextRenderable(renderer, { content: " * bookmarks", height: 1, fg: C.peach, selectable: false, onMouseDown: event => { event.preventDefault(); if (!modal && !busy) run(showBookmarks); } }));
    paths.forEach((path, index) => bookmarkPlaces.add(new TextRenderable(renderer, {
      id: `bookmark-${index}`, content: ` ${isRemoteBookmark(path) ? "↗ " + label(path.slice(6)) : "* " + label(basename(path) || path)}`, height: 1, fg: C.mint, truncate: true, selectable: false,
      onMouseDown: event => { event.preventDefault(); if (!modal && !busy) run(() => jumpBookmark(path)); },
    })));
    bookmarkPlaces.add(new TextRenderable(renderer, { id: "bookmark-toggle", content: paths.includes(bookmarkPath(cwd, mountsRoot)) ? " - unbookmark B" : " + bookmark B", height: 1, fg: C.muted, selectable: false, onMouseDown: event => { event.preventDefault(); if (!modal && !busy) run(toggleBookmark); } }));
  }
  function toggleBookmark() {
    savedBookmarks();
    const path = bookmarkPath(cwd, mountsRoot);
    const removed = bookmarksDB!.transaction(() => {
      const removed = bookmarksDB!.query("DELETE FROM bookmarks WHERE path = ?").run(path).changes > 0;
      if (!removed) bookmarksDB!.query("INSERT INTO bookmarks (path) VALUES (?)").run(path);
      return removed;
    }).immediate();
    refreshBookmarks();
    say(removed ? `Removed bookmark: ${path}` : `Bookmarked ${path}. Press b to jump back.`);
  }
  async function jumpBookmark(path: string) {
    busy = true;
    try {
      await load(path);
      closeModal(); previewFocused = false; list.focus(); layout();
      listPanel.borderColor = C.mint; previewPanel.borderColor = C.line;
      say(`Opened bookmark: ${path}`);
    } finally { busy = false; }
  }
  function showBookmarks() {
    const paths = savedBookmarks();
    refreshBookmarks();
    const scroll = dialog("Bookmarks", paths.length ? "" : "No bookmarks yet.\nPress Shift+B to save the current folder.");
    modalHeight = paths.length ? paths.length + 3 : 6;
    modal!.height = Math.min(modalHeight, renderer.height);
    if (!paths.length) return;
    const rows = Math.max(1, Math.min(paths.length, renderer.height - 3));
    const picker = new SelectRenderable(renderer, {
      id: "bookmark-picker", height: rows, showDescription: false, showScrollIndicator: true,
      options: paths.map(path => ({ name: isRemoteBookmark(path) ? ` SSHFS  ${label(path.slice(6))}` : ` ${label(basename(path) || path)}  ${label(path.replace(homedir(), "~"))}`, description: "", value: path })),
      textColor: C.ink, backgroundColor: C.panel, focusedBackgroundColor: C.panel, focusedTextColor: C.ink,
      selectedBackgroundColor: C.selected, selectedTextColor: C.ink,
      onMouseDown: (event) => {
        if (busy) return;
        const visible = Math.max(1, picker.height);
        const offset = Math.max(0, Math.min(picker.getSelectedIndex() - Math.floor(visible / 2), paths.length - visible));
        const path = paths[offset + event.y - picker.y];
        if (path) run(() => jumpBookmark(path));
      },
    });
    picker.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => run(() => jumpBookmark(option.value)));
    scroll.add(picker); picker.focus();
    modalMessage!.content = " Enter open · Esc close";
  }
  function connect() {
    ask("Connect SSHFS", "SSH alias or user@host:/absolute/path. Keys and trusted hosts required.", "", async target => {
      await load(`sshfs:${target}`);
      previewFocused = false; list.focus(); layout(); listPanel.borderColor = C.mint; previewPanel.borderColor = C.line;
      say("SSHFS connected. B saves it; y / x then p copies / moves between folders.");
    });
  }
  async function disconnect() {
    busy = true;
    try {
      const mount = await unmountRemote(cwd, mountsRoot);
      if (clipboard && (clipboard.path === mount.path || clipboard.path.startsWith(mount.path + "/"))) clipboard = undefined;
      await load(homedir());
      previewFocused = false; list.focus(); layout(); listPanel.borderColor = C.mint; previewPanel.borderColor = C.line;
      say(`Disconnected ${mount.target}. Remote bookmarks are kept.`);
    } finally { busy = false; }
  }
  function newEntry(folder: boolean) {
    ask(folder ? "New folder" : "New file", "Existing files are never overwritten.", "", async name => {
      const path = await create(cwd, name, folder); await load(cwd, path); say(`Created ${name}.`);
    });
  }
  function renameSelected() {
    const entry = selected(); if (!entry) return;
    ask("Rename", `Rename ${label(entry.name)}. Existing names are protected.`, entry.name, async name => {
      const path = await renameEntry(entry.path, name); await load(cwd, path); say(`Renamed to ${name}.`);
    });
  }
  function queueFile(cut: boolean) {
    const entry = selected(); clipboard = entry ? { path: entry.path, cut } : undefined;
    say(clipboard ? `${cut ? "Cut" : "Copied"} ${basename(clipboard.path)}. Go to a folder and press p.` : "No file selected.");
  }
  function trashSelected() {
    const entry = selected(); if (!entry) return;
    confirmAction("Move to trash", "Move to trash", `Move "${label(entry.name)}" to the system trash?\nPress t to restore it in Pocket or use your desktop file manager.`, async () => {
      if (!Bun.which("gio")) throw new Error("System trash needs gio. Nothing was removed.");
      const child = Bun.spawn(["gio", "trash", "--", entry.path], { stdout: "ignore", stderr: "pipe" });
      const error = await new Response(child.stderr).text();
      if (await child.exited) throw new Error(error || "Could not move to trash.");
      await load(cwd); say(`Moved ${entry.name} to trash.`);
    });
  }
  async function showTrash() {
    busy = true; say("Loading system trash…");
    try {
      const items = await trashEntries();
      if (disposed) return;
      const scroll = dialog("Trash", items.length ? "" : "The system trash is empty.");
      if (!items.length) { say("Trash is empty."); return; }
      let infoVersion = 0;
      const details = new TextRenderable(renderer, { id: "trash-info", height: 5, fg: C.muted, wrapMode: "word" });
      const picker = new SelectRenderable(renderer, {
        id: "trash-picker", height: Math.max(1, modal!.height - 10), showDescription: false, showScrollIndicator: true,
        options: items.map(item => ({ name: ` ${label(item.name)}`, description: "", value: item })),
        textColor: C.ink, backgroundColor: C.panel, focusedBackgroundColor: C.panel, focusedTextColor: C.ink,
        selectedBackgroundColor: C.selected, selectedTextColor: C.ink,
        onMouseDown: event => {
          event.preventDefault(); if (busy) return;
          const rows = Math.max(1, picker.height);
          const offset = Math.max(0, Math.min(picker.getSelectedIndex() - Math.floor(rows / 2), items.length - rows));
          const index = offset + event.y - picker.y;
          if (index >= 0 && index < items.length) picker.setSelectedIndex(index);
        },
      });
      picker.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
        const version = ++infoVersion, item = picker.getSelectedOption()?.value as TrashEntry | undefined;
        details.content = "Reading original location…";
        if (item) void trashInfo(item.uri).then(text => {
          if (!disposed && modal?.findDescendantById("trash-picker") === picker && version === infoVersion) details.content = clean(text);
        }, error => {
          if (!disposed && modal?.findDescendantById("trash-picker") === picker && version === infoVersion) details.content = clean(String(error));
        });
      });
      picker.on(SelectRenderableEvents.ITEM_SELECTED, () => { if (!busy) run(() => actOnTrash(false)); });
      scroll.add(picker); scroll.add(details);
      const buttons = new BoxRenderable(renderer, { height: 1, flexDirection: "row" });
      for (const [id, text, remove] of [["trash-restore", " Restore r ", false], ["trash-delete", " Delete forever d ", true]] as const) {
        buttons.add(new TextRenderable(renderer, { id, content: text, fg: remove ? C.error : C.mint, selectable: false, onMouseDown: event => { event.preventDefault(); if (!busy) run(() => actOnTrash(remove)); } }));
      }
      scroll.add(buttons); picker.focus(); picker.setSelectedIndex(0);
      modalMessage!.content = " Enter/r restore · d delete forever · F5 reload · Esc close";
      say(`${items.length} items in the system trash.`);
    } finally { busy = false; }
  }
  async function actOnTrash(remove: boolean) {
    const picker = modal?.findDescendantById("trash-picker") as SelectRenderable | undefined;
    const item = picker?.getSelectedOption()?.value as TrashEntry | undefined;
    if (!item) return;
    if (remove) {
      confirmAction("Delete permanently", "Delete forever", `Permanently delete "${label(item.name)}"?\nThis cannot be undone. Folders include all their contents.`, async () => {
        await deleteTrash(item.uri); await showTrash(); say(`Permanently deleted ${item.name}.`);
        if (modalMessage) modalMessage.content = " Permanently deleted. F5 reload · Esc close";
      });
    } else {
      busy = true;
      try {
        await restoreTrash(item.uri);
        await load(cwd).catch(error => say(`Restored, but could not refresh this folder: ${String(error)}`, true));
        await showTrash(); say(`Restored ${item.name} to its original location.`);
        if (modalMessage) modalMessage.content = " Restored. Enter/r restores · d deletes · Esc close";
      } finally { busy = false; }
    }
  }
  function help() {
    dialog("A tiny field guide", `FILES\n↑ ↓ or j k  choose a file\nEnter  open in the host's default app\nMedia-only folder / file inside  open a playlist\n→ / l  step into a folder or open a file\n← / h / Backspace  parent folder\nTab  files / preview, arrows scroll preview\nDrag over text  copy selection when released\n/  find in this folder    Esc  clear filter\n.  show hidden files     g  go to a path\nHome  first file         End  last file\nB  toggle folder bookmark    b  jump to bookmark\nc  connect SSHFS    u  disconnect this mount\nRemote bookmarks reconnect using SSH keys/config\n\nMAKE & EDIT\ne  edit with $EDITOR, defaults to vi\no  open in the host's default app\nn  new file             N  new folder\nr  rename               y  copy selected file or folder\nx  cut selected file or folder\np  paste copy / move, no overwrite\nd  move to system trash, confirmation required\nt  browse trash; Enter/r restores, d deletes forever\nSpace  play / stop music on the host\nF5  refresh folder\n\nSHARED SESSION\ns  SSH connection and QR code\nCtrl+B then %  split left / right\nCtrl+B then \"  split top / bottom\nCtrl+B then c  new shell tab\nCtrl+B then arrows  switch panes\nCtrl+B then n / p  next / previous tab\nCtrl+B then d  detach, leave session running\n\n?  this guide    q  close file manager\nSSH users share control and your OS permissions.`);
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
    if (modal) {
      const trashPicker = modal.findDescendantById("trash-picker");
      if (!key.ctrl && !key.meta && !key.super && ((trashPicker && ["r", "d"].includes(key.name)) || (modal.title === " Trash " && key.name === "f5"))) {
        key.preventDefault(); run(key.name === "f5" ? showTrash : () => actOnTrash(key.name === "d")); return;
      }
      if (key.name === "escape") { key.preventDefault(); closeModal(); }
      else (prompt ?? modal.findDescendantById("confirm-choices") ?? modal.findDescendantById("bookmark-picker") ?? modal.findDescendantById("trash-picker") ?? modal.findDescendantById("dialog-content"))?.focus();
      return;
    }
    if (searchInput.focused) {
      if (key.name === "escape" || key.name === "tab") {
        key.preventDefault(); finishSearch(key.name === "escape");
      }
      return;
    }
    if (key.ctrl || key.meta || key.super) return;
    if (key.name === "b" || key.name === "B") {
      key.preventDefault(); run(key.shift || key.sequence === "B" ? toggleBookmark : showBookmarks); return;
    }
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
    const globalAction = key.name === "/" ? search : key.name === "s" ? share : key.name === "c" ? connect : key.name === "t" ? showTrash : key.name === "u" ? disconnect : key.name === "e" ? edit : key.name === "o" || key.name === "return" ? openHost : key.name === "space" ? toggleMusic : undefined;
    if (globalAction) { key.preventDefault(); run(globalAction); return; }
    if (previewFocused) return;
    const actions: Record<string, () => void | Promise<unknown>> = {
      e: edit, "/": search, n: () => newEntry(key.shift), N: () => newEntry(true), r: renameSelected, d: trashSelected,
      s: share, ".": () => { hidden = !hidden; filter(); },
      g: () => ask("Go to folder", "Absolute or relative path. ~ means your home.", cwd, async path => load(resolve(cwd, path.replace(/^~(?=\/|$)/, homedir())))),
      y: () => queueFile(false), x: () => queueFile(true),
      p: async () => {
        const item = clipboard; if (!item) throw new Error("Press y or x on a file first.");
        busy = true;
        try {
          say(item.cut ? "Moving…" : "Copying…");
          const path = await (item.cut ? moveInto(item.path, cwd) : copyInto(item.path, cwd));
          if (item.cut) clipboard = undefined;
          await load(cwd, path); say(item.cut ? "Move pasted." : "Copy pasted.");
        } finally { busy = false; }
      },
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
    player?.kill(); bookmarksDB?.close(); syntaxStyle.destroy();
    renderer.off("resize", layout); renderer.keyInput.off("keypress", onKey);
    renderer.off("selection", copySelection);
  });
  list.focus();
  const ready = load(cwd).catch(error => say(String(error), true));
  return { ready, load, list, help, share, get cwd() { return cwd; }, get playingPath() { return playingPath; } };
}
