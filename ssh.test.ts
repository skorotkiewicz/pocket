import { test, expect } from "bun:test";
import { mkdtemp, mkdir, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { textPreview } from "./files";

async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await Bun.sleep(40); }
  throw new Error(message);
}

// Opt-in because this test starts a real server and needs tmux, ssh and ssh-keygen.
test.skipIf(process.env.POCKET_SSH_TEST !== "1")("two SSH clients share files, editor and QR; disconnect preserves the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-integration-"));
  let server: ReturnType<typeof Bun.spawn> | undefined;
  const clients: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const folder = join(directory, "files"); await mkdir(folder);
    await Bun.write(join(folder, "hello.txt"), "original\n");
    const keygen = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(directory, "client")]);
    expect(await keygen.exited).toBe(0);
    const editor = join(directory, "editor");
    await Bun.write(editor, '#!/bin/sh\nprintf "edited through SSH\\n" >> "$1"\n'); await chmod(editor, 0o700);
    server = Bun.spawn([resolve("server/target/debug/cute-tui-server"), folder, "--headless", "--listen", "127.0.0.1:0", "--authorized-keys", join(directory, "client.pub"), "--state-dir", join(directory, "state")], { env: { ...process.env, EDITOR: editor }, stdout: "pipe", stderr: "pipe" });
    let log = "";
    const readLog = (async () => { for await (const chunk of server!.stdout as ReadableStream<Uint8Array>) log += new TextDecoder().decode(chunk); })();
    await waitFor(() => log.includes("Pairing password:"), "Server did not start");
    const port = log.match(/ssh -t -p (\d+)/)![1]!;
    const password = log.match(/Pairing password: ([a-f0-9]+)/)![1]!;
    const screen = async () => {
      const capture = Bun.spawn(["tmux", "-L", `pocket-${server!.pid}`, "capture-pane", "-p"], { stdout: "pipe", stderr: "ignore" });
      return new Response(capture.stdout).text();
    };
    const args = ["ssh", "-F", "/dev/null", "-x", "-tt", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${directory}/known_hosts`, "-o", "IdentitiesOnly=yes", "-o", "LogLevel=ERROR", "-p", port];
    const connect = (extra: string[], env = process.env) => {
      const output = { text: "" };
      const client = Bun.spawn([...args, ...extra, "pocket@127.0.0.1"], {
        env,
        terminal: { cols: 110, rows: 32, data(_terminal, bytes) { output.text += new TextDecoder().decode(bytes); } },
      });
      clients.push(client);
      return { client, output };
    };
    const first = connect(["-i", join(directory, "client"), "-o", "BatchMode=yes"]);
    await waitFor(() => first.output.text.includes("hello.txt"), "Key-authenticated client did not render");
    // Password authentication uses an askpass helper instead of typing secrets into the PTY.
    const askpass = join(directory, "askpass");
    await Bun.write(askpass, '#!/bin/sh\nprintf "%s" "$PAIRING"\n'); await chmod(askpass, 0o700);
    const second = connect(["-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"], { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0", PAIRING: password });
    await waitFor(() => second.output.text.includes("hello.txt"), "Password-authenticated client did not render");
    first.client.terminal!.write("n");
    await waitFor(() => second.output.text.includes("New file"), "Dialog was not shared with the second client");
    first.client.terminal!.write("shared.txt\r");
    await waitFor(() => Bun.file(join(folder, "shared.txt")).exists(), "SSH file creation failed");
    await waitFor(async () => !(await screen()).includes("New file"), "File creation dialog did not close");
    second.client.terminal!.write("e");
    await waitFor(async () => (await Bun.file(join(folder, "shared.txt")).text()).includes("edited through SSH"), "$EDITOR did not receive the selected file");
    await waitFor(async () => (await screen()).includes("edited through SSH"), "Editor did not restore the preview");
    const beforeCopy = second.output.text.length;
    const clipboardPayload = Buffer.from(await textPreview(join(folder, "shared.txt"))).toString("base64");
    second.client.terminal!.write("\t\r");
    await waitFor(() => second.output.text.slice(beforeCopy).includes(clipboardPayload), "Preview clipboard payload did not reach the SSH terminal");
    // Keep focus change and the next action ordered on one SSH connection.
    second.client.terminal!.write("\ts");
    await waitFor(() => second.output.text.includes("Pairing password for this server run"), "Share dialog was not broadcast");
    expect(second.output.text).toContain("ssh://pocket@127.0.0.1:");
    expect(second.output.text).toContain("Host key fingerprint");
    first.client.terminal!.write("\x1b");
    await waitFor(async () => !(await screen()).includes("Join the same pocket"), "Escape did not close the shared dialog");
    first.client.kill(); first.client.terminal!.close(); await first.client.exited;
    second.client.terminal!.resize(84, 25);
    second.client.terminal!.write("n");
    await waitFor(async () => (await screen()).includes("New file"), "Remaining client could not open a dialog");
    second.client.terminal!.write("after-disconnect.txt\r");
    await waitFor(() => Bun.file(join(folder, "after-disconnect.txt")).exists(), "Remaining SSH client could not create a file after disconnect");
    await waitFor(async () => !(await screen()).includes("New file"), "Second file creation dialog did not close");
    second.client.terminal!.write("\x02%");
    await waitFor(async () => {
      const panes = Bun.spawn(["tmux", "-L", `pocket-${server!.pid}`, "list-panes", "-F", "#{pane_id}"], { stdout: "pipe", stderr: "ignore" });
      return (await new Response(panes.stdout).text()).trim().split("\n").length === 2;
    }, "Multiplexer did not split");
    const panes = Bun.spawn(["tmux", "-L", `pocket-${server.pid}`, "list-panes", "-F", "#{pane_id}"], { stdout: "pipe", stderr: "ignore" });
    expect((await new Response(panes.stdout).text()).trim().split("\n").length).toBe(2);
    second.client.terminal!.write("printf 'hello from a split pane' > shell-pane.txt\r");
    await waitFor(() => Bun.file(join(folder, "shell-pane.txt")).exists(), "Multiplexer shell pane did not accept input");
    const fingerprint = Bun.spawn(["ssh-keygen", "-lf", join(directory, "known_hosts")], { stdout: "pipe", stderr: "ignore" });
    expect(await new Response(fingerprint.stdout).text()).toContain(log.match(/Host key: (SHA256:\S+)/)![1]!);
    const reject = Bun.spawn([...args.slice(0, -2), "-p", port, "-o", "BatchMode=yes", "-o", "PreferredAuthentications=none", "root@127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
    expect(await reject.exited).not.toBe(0);
    const exec = Bun.spawn(["ssh", "-F", "/dev/null", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${directory}/known_hosts`, "-o", "BatchMode=yes", "-i", join(directory, "client"), "-p", port, "pocket@127.0.0.1", "touch", join(folder, "should-not-exist")], { stdout: "ignore", stderr: "ignore" });
    expect(await exec.exited).not.toBe(0);
    expect(await Bun.file(join(folder, "should-not-exist")).exists()).toBe(false);
    server.kill("SIGINT"); expect(await server.exited).toBe(0); await readLog;
  } catch (error) {
    // Do not dump terminal output: the share dialog contains pairing credentials.
    console.error("SSH smoke test failed. Terminal output withheld because it contains credentials.");
    throw error;
  } finally {
    for (const client of clients) { client.kill(); client.terminal?.close(); }
    if (server) { server.kill("SIGINT"); await server.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
