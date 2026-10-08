# Pocket

A cat-sized OpenTUI file manager. Peach labels, mint selection, compact panels, clickable places and a keyboard guide built into `?`.

- Browse folders, filter names, show hidden files and scroll text previews.
- Preview PNG, JPEG, WebP and GIF using OpenTUI's native image decoder. tmux uses terminal blocks, so images also work over SSH.
- Read music tags and a real waveform. Space starts or stops playback with ffplay.
- Edit with `$EDITOR`, with `vi` as the fallback. The file manager restores itself when the editor exits.
- Create files and folders, rename, copy and paste. Existing files are protected. Moving to system trash requires typing `trash` to confirm.
- Split panes and open shell tabs with tmux. The Rust SSH server attaches clients to that same session, including the running editor.
- Press `s` for an SSH QR code, pairing password and host fingerprint.

## Run

Linux is the supported host. Install Bun, Rust, tmux and GNU coreutils. FFmpeg enables audio metadata, waveform and playback. `gio`, supplied by GLib, enables system trash.

For example, on Debian or Ubuntu:

```sh
sudo apt install tmux coreutils ffmpeg libglib2.0-bin openssh-client
bun install
bun run start
```

Open a particular folder:

```sh
EDITOR='nvim' bun run start ~/Documents
```

Start just the file manager, without SSH or tmux:

```sh
bun run dev
# Or:
bun index.ts ~/Documents
```

The sidebar disappears on smaller terminals. Below 72 columns, Tab switches between the file list and preview.

## Join from another device

By default, SSH listens only on `127.0.0.1:2222`. To allow another device on your LAN, supply this computer's LAN address:

```sh
bun run start ~/Documents --listen 0.0.0.0:2222 --host 192.168.1.42
```

Press `s`, then scan the QR with an SSH app that supports `ssh://` links. A normal camera app may not open these links. You can also enter the shown SSH command manually:

```sh
ssh -t -p 2222 pocket@192.168.1.42
```

Compare the client's host fingerprint with the one shown in Pocket before accepting the connection. Enter the random password shown in the share dialog. That password lasts for this server run. The QR contains the address, not the password.

All clients share control. Navigation, edits, panes and tabs are visible to everyone. Disconnecting a client does not end the session. Audio plays through the host's audio device, not through the remote SSH client.

For public-key-only access:

```sh
bun run start --keys-only --authorized-keys ~/.ssh/id_ed25519.pub
```

Without `--authorized-keys`, the server reads `~/.ssh/authorized_keys`. It accepts plain key lines only. Entries with restrictions such as `from=` or `command=` are skipped rather than silently granting unrestricted access. The SSH login name is always `pocket`, independent of your OS username.

The persistent Ed25519 host key is stored at `~/.local/share/pocket/ssh_host_ed25519_key` with private permissions. Use `--state-dir` to choose another location.

For an unattended session:

```sh
bun run start ~/Documents --headless --listen 0.0.0.0:2222 --host 192.168.1.42
```

Headless mode prints the pairing password to standard output. Keep that output private, or use `--keys-only`.

## Keys

| Key | Action |
| --- | --- |
| Arrows, j / k | Navigate files |
| Enter, right, l | Open folder, edit text, preview image or play music |
| Left, h, Backspace | Parent folder |
| Tab | Switch files and preview focus |
| / | Filter this folder's file names |
| Esc | Close dialog or clear filter |
| . | Show hidden files |
| g | Go to a folder |
| e | Edit with `$EDITOR` |
| n / Shift+n | New file / folder |
| r | Rename |
| y, then p | Copy, then paste into the current folder |
| d | Move to system trash, with confirmation |
| Space | Play / stop music |
| F5 | Refresh |
| s | Share SSH connection |
| ? | All shortcuts |
| q | Close the file manager pane |

Tmux uses its normal prefix, Ctrl+B. Release it, then press `%` to split left/right, `"` to split top/bottom, `c` for a shell tab, arrows to switch panes, or `n` / `p` to switch tabs. `d` detaches your local terminal while the Rust server keeps running.

The server stops when the last pane exits or when you interrupt the server process. Stopping it closes all panes, so save editor buffers first. Do not run it as root. SSH users have your filesystem and shell permissions. This is for trusted people, not a sandbox or a public hosting service. Arbitrary SSH exec, SFTP, forwarding and agent forwarding are disabled, but authenticated users can open shells inside tmux.

## Checks

```sh
bun test
bun run check
bun run server:test
cargo clippy --manifest-path server/Cargo.toml -- -D warnings
bun run ssh:test
```

The SSH smoke test starts a real Rust server and two real SSH clients. It checks key and password authentication, shared file creation, `$EDITOR`, the share dialog, resizing, disconnect survival, rejected unauthenticated access and rejected SSH exec.

Text previews read at most 64 KB and show up to 500 lines. Image files larger than 32 MB are not decoded. Waveforms sample the first 30 seconds. Directory changes made outside Pocket appear after F5.
