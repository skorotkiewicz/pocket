use anyhow::{Context, Result, bail};
use clap::Parser;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use russh::{
    Channel, ChannelId, Pty,
    keys::{Algorithm, HashAlg, PrivateKey, PublicKey},
    server::{self, Auth, Msg, Server as _, Session},
};
#[cfg(feature = "embedded-tui")]
use std::os::unix::fs::DirBuilderExt;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::SocketAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::mpsc};

#[derive(Parser, Debug)]
#[command(about = "Pocket: an OpenTUI file manager with a shared SSH session")]
struct Options {
    /// Folder to open
    #[arg(default_value = ".")]
    path: PathBuf,
    /// SSH listen address. Use 0.0.0.0:2222 for LAN access
    #[arg(long, default_value = "127.0.0.1:2222")]
    listen: SocketAddr,
    /// Hostname or IP in the QR code. Required for wildcard listen addresses
    #[arg(long)]
    host: Option<String>,
    /// OpenSSH public keys file. Only plain, unrestricted key lines are accepted
    #[arg(long)]
    authorized_keys: Option<PathBuf>,
    /// Disable the random, per-run pairing password
    #[arg(long)]
    keys_only: bool,
    /// Serve without attaching this terminal
    #[arg(long)]
    headless: bool,
    /// Directory for the persistent SSH host key
    #[arg(long)]
    state_dir: Option<PathBuf>,
}

struct Shared {
    socket: String,
    user: String,
    password: Option<String>,
    keys: Vec<PublicKey>,
}
impl Shared {
    fn password_auth(&self, user: &str, password: &str) -> Auth {
        if user == self.user
            && self
                .password
                .as_ref()
                .is_some_and(|expected| bool::from(expected.as_bytes().ct_eq(password.as_bytes())))
        {
            Auth::Accept
        } else {
            Auth::reject()
        }
    }
    fn key_auth(&self, user: &str, key: &PublicKey) -> Auth {
        if user == self.user
            && self
                .keys
                .iter()
                .any(|allowed| allowed.key_data() == key.key_data())
        {
            Auth::Accept
        } else {
            Auth::reject()
        }
    }
}
struct SshServer(Arc<Shared>);
impl server::Server for SshServer {
    type Handler = Client;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Client {
        Client {
            shared: self.0.clone(),
            sizes: HashMap::new(),
            terminals: HashMap::new(),
        }
    }
    fn handle_session_error(&mut self, error: anyhow::Error) {
        eprintln!("SSH connection: {error}");
    }
}

struct Terminal {
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    output: tokio::task::JoinHandle<()>,
}
impl Drop for Terminal {
    fn drop(&mut self) {
        // Kill only this tmux client. The shared session and its editor stay alive.
        let _ = self.killer.kill();
        self.output.abort();
    }
}
struct Client {
    shared: Arc<Shared>,
    sizes: HashMap<ChannelId, PtySize>,
    terminals: HashMap<ChannelId, Terminal>,
}
fn terminal_size(cols: u32, rows: u32) -> Option<PtySize> {
    if !(1..=500).contains(&cols) || !(1..=200).contains(&rows) {
        return None;
    }
    Some(PtySize {
        cols: cols as u16,
        rows: rows as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}
impl server::Handler for Client {
    type Error = anyhow::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth> {
        Ok(self.shared.password_auth(user, password))
    }
    async fn auth_publickey_offered(&mut self, user: &str, key: &PublicKey) -> Result<Auth> {
        Ok(self.shared.key_auth(user, key))
    }
    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth> {
        Ok(self.shared.key_auth(user, key))
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<()> {
        // One PTY per SSH connection. No exec, SFTP, agent or TCP forwarding.
        if self.sizes.is_empty() {
            self.sizes.insert(channel.id(), PtySize::default());
            reply.accept().await;
        }
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<()> {
        if let Some(size) = terminal_size(cols, rows)
            .filter(|_| self.sizes.contains_key(&channel) && !self.terminals.contains_key(&channel))
        {
            self.sizes.insert(channel, size);
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }
    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<()> {
        let Some(size) = self
            .sizes
            .get(&channel)
            .copied()
            .filter(|_| !self.terminals.contains_key(&channel))
        else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        let pair = native_pty_system().openpty(size)?;
        let mut command = CommandBuilder::new("tmux");
        command.args(["-L", &self.shared.socket, "attach-session", "-t", "pocket"]);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env_remove("TMUX");
        let mut child = pair.slave.spawn_command(command)?;
        let killer = child.clone_killer();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (input, mut receive_input) = mpsc::channel::<Vec<u8>>(16);
        tokio::task::spawn_blocking(move || {
            while let Some(data) = receive_input.blocking_recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
        });
        let (send_output, mut receive_output) = mpsc::channel::<Vec<u8>>(16);
        tokio::task::spawn_blocking(move || {
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if send_output.blocking_send(buffer[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let handle = session.handle();
        let output = tokio::spawn(async move {
            while let Some(data) = receive_output.recv().await {
                if handle.data(channel, data).await.is_err() {
                    return;
                }
            }
            let _ = handle.eof(channel).await;
            let _ = handle.close(channel).await;
        });
        tokio::task::spawn_blocking(move || {
            let _ = child.wait();
        });
        self.terminals.insert(
            channel,
            Terminal {
                master: pair.master,
                input,
                killer,
                output,
            },
        );
        session.channel_success(channel)?;
        Ok(())
    }
    async fn data(&mut self, channel: ChannelId, data: &[u8], _: &mut Session) -> Result<()> {
        if let Some(terminal) = self.terminals.get(&channel) {
            let _ = terminal.input.send(data.to_vec()).await;
        }
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        session: &mut Session,
    ) -> Result<()> {
        if let Some(size) = terminal_size(cols, rows) {
            if let Some(terminal) = self.terminals.get(&channel) {
                terminal.master.resize(size)?;
            }
            if let Some(current) = self.sizes.get_mut(&channel) {
                *current = size;
            }
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }
    async fn channel_close(&mut self, channel: ChannelId, _: &mut Session) -> Result<()> {
        self.terminals.remove(&channel);
        self.sizes.remove(&channel);
        Ok(())
    }
    async fn channel_eof(&mut self, channel: ChannelId, session: &mut Session) -> Result<()> {
        self.terminals.remove(&channel);
        self.sizes.remove(&channel);
        session.close(channel)?;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _: &[u8],
        session: &mut Session,
    ) -> Result<()> {
        session.channel_failure(channel)?;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        session: &mut Session,
    ) -> Result<()> {
        session.channel_failure(channel)?;
        Ok(())
    }
}

fn host_key(directory: &Path) -> Result<PrivateKey> {
    std::fs::create_dir_all(directory)?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    let path = directory.join("ssh_host_ed25519_key");
    if path.try_exists()? {
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
            bail!(
                "Host key must be a regular file with permissions 0600: {}",
                path.display()
            );
        }
        return russh::keys::load_secret_key(&path, None).context("Read SSH host key");
    }
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(key.to_openssh(Default::default())?.as_bytes())?;
    file.sync_all()?;
    Ok(key)
}
fn authorized_keys(path: &Path, explicit: bool) -> Result<Vec<PublicKey>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if !explicit && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(vec![]);
        }
        Err(error) => return Err(error).context("Read authorized keys"),
    };
    let mut keys = vec![];
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        // Never discard authorized_keys options such as from= or command=.
        // Restricted entries are rejected, rather than silently granting full access.
        if line.starts_with("ssh-") || line.starts_with("ecdsa-") {
            keys.push(PublicKey::from_openssh(line).context("Invalid public key")?);
        } else {
            eprintln!("Skipping restricted/unsupported authorized_keys entry.");
        }
    }
    Ok(keys)
}
fn tmux(socket: &str) -> Command {
    let mut command = Command::new("tmux");
    command.args(["-L", socket, "-f", "/dev/null"]);
    command.env_remove("TMUX");
    command
}
struct SessionGuard(String);
impl Drop for SessionGuard {
    fn drop(&mut self) {
        let _ = tmux(&self.0).args(["kill-server"]).output();
    }
}

#[cfg(feature = "embedded-tui")]
const TUI_BINARY: &[u8] = include_bytes!(env!("POCKET_TUI_BINARY"));

#[cfg(feature = "embedded-tui")]
struct ExtractedTui(PathBuf);

#[cfg(feature = "embedded-tui")]
impl ExtractedTui {
    fn extract() -> Result<Self> {
        // ponytail: per-run extraction avoids cache trust/locking; add a verified cache if startup IO matters.
        let directory = std::env::temp_dir().join(format!(
            "pocket-tui-{}-{:032x}",
            std::process::id(),
            rand::random::<u128>()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .context("Create private TUI runtime directory. Check TMPDIR.")?;
        let tui = Self(directory);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(tui.0.join("pocket-tui"))
            .context("Create bundled TUI executable")?;
        file.write_all(TUI_BINARY).context("Extract bundled TUI")?;
        file.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        Ok(tui)
    }
}

#[cfg(feature = "embedded-tui")]
impl Drop for ExtractedTui {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let options = Options::parse();
    let folder = options
        .path
        .canonicalize()
        .context("Open starting folder")?;
    if !folder.is_dir() {
        bail!("Starting path must be a folder");
    }
    let host = match options.host {
        Some(host)
            if !host.is_empty()
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c)) =>
        {
            host
        }
        Some(_) => bail!("--host must be a hostname or IP address"),
        None if options.listen.ip().is_unspecified() => {
            bail!("Use --host YOUR_LAN_IP with a wildcard listen address")
        }
        None => options.listen.ip().to_string(),
    };
    let tools: &[&str] = if cfg!(feature = "embedded-tui") {
        &["tmux"]
    } else {
        &["tmux", "bun"]
    };
    for &tool in tools {
        let output = Command::new(tool)
            .arg(if tool == "tmux" { "-V" } else { "--version" })
            .output()
            .with_context(|| format!("Install {tool} first"))?;
        if !output.status.success() {
            bail!("{tool} is unavailable");
        }
    }
    let home = PathBuf::from(std::env::var("HOME").context("HOME is not set")?);
    let state = options
        .state_dir
        .unwrap_or_else(|| home.join(".local/share/pocket"));
    let key = host_key(&state)?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    let keys = authorized_keys(
        &options
            .authorized_keys
            .clone()
            .unwrap_or_else(|| home.join(".ssh/authorized_keys")),
        options.authorized_keys.is_some(),
    )?;
    if options.keys_only && keys.is_empty() {
        bail!("--keys-only requires at least one unrestricted authorized key");
    }
    let password = (!options.keys_only).then(|| {
        rand::random::<[u8; 16]>()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    });
    let user = "pocket".to_string();
    let listener = TcpListener::bind(options.listen)
        .await
        .context("Bind SSH listener")?;
    let port = listener.local_addr()?.port();
    let socket = format!("pocket-{}", std::process::id());
    let uri_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let uri = format!("ssh://{user}@{uri_host}:{port}");
    let ssh_command = format!("ssh -t -p {port} {user}@{host}");
    #[cfg(feature = "embedded-tui")]
    let tui = ExtractedTui::extract()?;
    let mut launch = tmux(&socket);
    launch
        .args([
            "new-session",
            "-d",
            "-s",
            "pocket",
            "-x",
            "120",
            "-y",
            "36",
            "-c",
        ])
        .arg(&folder)
        .arg("--");
    #[cfg(feature = "embedded-tui")]
    launch.arg(tui.0.join("pocket-tui"));
    #[cfg(not(feature = "embedded-tui"))]
    {
        let project = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .context("Project directory")?;
        launch.arg("bun").arg(project.join("src/index.ts"));
    }
    let status = launch
        .arg(&folder)
        .env("CUTE_SOCKET", &socket)
        .env("CUTE_SSH_URI", &uri)
        .env("CUTE_SSH_COMMAND", &ssh_command)
        .env(
            "CUTE_PAIRING",
            password
                .as_deref()
                .unwrap_or("Disabled. Use an authorized SSH key."),
        )
        .env("CUTE_FINGERPRINT", &fingerprint)
        .status()
        .context("Start tmux session")?;
    if !status.success() {
        bail!("tmux could not start the file manager");
    }
    let _guard = SessionGuard(socket.clone());
    for args in [
        vec!["set-option", "-g", "status-style", "bg=#455d49,fg=#f5ead7"],
        vec!["set-option", "-g", "status-left", " (=^.^=) pocket "],
        vec![
            "set-option",
            "-g",
            "status-right",
            " ^B % split | ^B c tab | ^B d detach ",
        ],
        vec!["set-option", "-g", "mouse", "on"],
        vec!["set-option", "-s", "escape-time", "10"],
        vec!["set-option", "-s", "set-clipboard", "on"],
        vec!["set-option", "-g", "allow-passthrough", "on"],
        vec!["set-option", "-g", "default-terminal", "tmux-256color"],
        vec!["set-option", "-g", "window-size", "smallest"],
    ] {
        let output = tmux(&socket).args(args).output()?;
        if !output.status.success() {
            eprintln!("tmux: {}", String::from_utf8_lossy(&output.stderr));
        }
    }
    let config = Arc::new(server::Config {
        keys: vec![key],
        max_auth_attempts: 5,
        auth_rejection_time: Duration::from_secs(1),
        auth_rejection_time_initial: Some(Duration::ZERO),
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval: Some(Duration::from_secs(30)),
        nodelay: true,
        ..Default::default()
    });
    let shared = Arc::new(Shared {
        socket: socket.clone(),
        user,
        password,
        keys,
    });
    let mut ssh = SshServer(shared.clone());
    let server = ssh.run_on_socket(config, &listener);
    let shutdown = server.handle();
    tokio::pin!(server);
    println!("Pocket SSH: {ssh_command}\nHost key: {fingerprint}");
    if options.headless {
        println!(
            "Pairing password: {}",
            shared.password.as_deref().unwrap_or("disabled")
        );
    } else {
        let socket = socket.clone();
        tokio::task::spawn_blocking(move || {
            let _ = tmux(&socket)
                .args(["attach-session", "-t", "pocket"])
                .status();
            eprintln!("Detached. SSH session is still running. Ctrl+C stops the server.");
        });
    }
    // Local detach and remote disconnect do not end the server. Last pane exit does.
    loop {
        tokio::select! {
            result = &mut server => { result?; return Ok(()); }
            result = tokio::signal::ctrl_c() => { result?; break; }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if !tmux(&socket).args(["has-session", "-t", "pocket"]).output()?.status.success() { break; }
            }
        }
    }
    shutdown.shutdown("Pocket server stopped".into());
    tokio::time::timeout(Duration::from_secs(3), &mut server)
        .await
        .context("SSH shutdown timed out")??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "embedded-tui")]
    #[test]
    fn bundled_tui_is_private_complete_and_removed_on_drop() {
        let tui = ExtractedTui::extract().unwrap();
        let directory = tui.0.clone();
        let executable = directory.join("pocket-tui");
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&executable).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(std::fs::read(executable).unwrap(), TUI_BINARY);
        drop(tui);
        assert!(!directory.exists());
    }

    #[test]
    fn authentication_and_terminal_boundaries() {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let shared = Shared {
            socket: "test".into(),
            user: "pocket".into(),
            password: Some("random-secret".into()),
            keys: vec![key.public_key().clone()],
        };
        assert_eq!(
            shared.password_auth("pocket", "random-secret"),
            Auth::Accept
        );
        assert_ne!(shared.password_auth("pocket", "wrong"), Auth::Accept);
        assert_ne!(shared.password_auth("root", "random-secret"), Auth::Accept);
        assert_eq!(shared.key_auth("pocket", key.public_key()), Auth::Accept);
        assert_ne!(shared.key_auth("root", key.public_key()), Auth::Accept);
        let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        assert_ne!(shared.key_auth("pocket", other.public_key()), Auth::Accept);
        assert!(terminal_size(80, 24).is_some());
        assert!(terminal_size(0, 24).is_none());
        assert!(terminal_size(u32::MAX, 24).is_none());
    }
}
