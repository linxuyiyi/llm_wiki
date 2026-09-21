use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Read;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const MCP_HTTP_PORT: u16 = 19_898;
pub const MCP_HTTP_PATH: &str = "/mcp";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpStatus {
    pub state: String,
    pub host: String,
    pub port: u16,
    pub mcp_url: String,
    pub health_url: String,
    pub pid: Option<u32>,
    pub auth_configured: bool,
    pub message: Option<String>,
    pub log_path: Option<String>,
}

pub struct McpHttpState {
    child: Mutex<Option<Child>>,
    status: Mutex<McpHttpStatus>,
}

impl Default for McpHttpState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(status_for("disabled", "127.0.0.1", None, false, None, None)),
        }
    }
}

impl Drop for McpHttpState {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedApiConfig {
    enabled: Option<bool>,
    allow_lan_access: Option<bool>,
    mcp_enabled: Option<bool>,
    token: Option<String>,
}

#[derive(Debug, Clone)]
struct RuntimeConfig {
    api_enabled: bool,
    mcp_enabled: bool,
    allow_lan_access: bool,
    api_token: Option<String>,
    transport_token: Option<String>,
}

pub fn sync_from_config(app: &AppHandle) -> Result<McpHttpStatus, String> {
    let config = load_runtime_config(app);
    let host = if config.allow_lan_access { "0.0.0.0" } else { "127.0.0.1" };
    let state = app.state::<McpHttpState>();

    stop_child(&state)?;

    if !config.api_enabled || !config.mcp_enabled {
        let status = status_for(
            "disabled",
            host,
            None,
            config.transport_token.is_some(),
            Some(if !config.api_enabled {
                "HTTP API is disabled".to_string()
            } else {
                "MCP access is disabled".to_string()
            }),
            None,
        );
        set_status(&state, status.clone());
        return Ok(status);
    }

    if let Err(message) = preflight_port(host) {
        let status = status_for(
            "error",
            host,
            None,
            config.transport_token.is_some(),
            Some(message.clone()),
            None,
        );
        set_status(&state, status);
        return Err(message);
    }

    let entry = match resolve_mcp_entry_path(app) {
        Ok(path) => path,
        Err(message) => {
            let status = status_for(
                "error",
                host,
                None,
                config.transport_token.is_some(),
                Some(message.clone()),
                None,
            );
            set_status(&state, status);
            return Err(message);
        }
    };
    let runtime = resolve_node_runtime(app);
    let log_path = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data directory for HTTP MCP log: {err}"))?
        .join("mcp-http.log");
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create HTTP MCP log directory: {err}"))?;
    }
    let log_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|err| format!("Failed to open HTTP MCP log file: {err}"))?;
    let stdout_log = log_file
        .try_clone()
        .map_err(|err| format!("Failed to clone HTTP MCP log handle: {err}"))?;
    let stderr_log = log_file;


    let mut command = match runtime {
        Some(path) => Command::new(path),
        None => Command::new("node"),
    };
    command
        .arg(&entry)
        .args([
            "--transport",
            "http",
            "--host",
            host,
            "--port",
            &MCP_HTTP_PORT.to_string(),
            "--path",
            MCP_HTTP_PATH,
        ])
        .env("LLM_WIKI_API_BASE_URL", "http://127.0.0.1:19828")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));

    if let Some(token) = config.api_token.as_deref() {
        command.env("LLM_WIKI_API_TOKEN", token);
    } else {
        command.env_remove("LLM_WIKI_API_TOKEN");
    }
    if let Some(token) = config.transport_token.as_deref() {
        command.env("LLM_WIKI_MCP_AUTH_TOKEN", token);
    } else {
        command.env_remove("LLM_WIKI_MCP_AUTH_TOKEN");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            match wait_until_ready(&mut child, &log_path) {
                Ok(()) => {
                    let mut guard = state
                        .child
                        .lock()
                        .map_err(|_| "HTTP MCP process state is unavailable".to_string())?;
                    *guard = Some(child);
                    drop(guard);
                    let status = status_for(
                        "running",
                        host,
                        Some(pid),
                        config.transport_token.is_some(),
                        None,
                        Some(log_path.to_string_lossy().into_owned()),
                    );
                    set_status(&state, status.clone());
                    eprintln!(
                        "[MCP HTTP] auto-started pid={pid} at {host}:{}{}",
                        MCP_HTTP_PORT, MCP_HTTP_PATH
                    );
                    Ok(status)
                }
                Err(message) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let status = status_for(
                        "error",
                        host,
                        None,
                        config.transport_token.is_some(),
                        Some(message.clone()),
                        Some(log_path.to_string_lossy().into_owned()),
                    );
                    set_status(&state, status);
                    Err(message)
                }
            }
        }
        Err(err) => {
            let message = format!(
                "Failed to start bundled HTTP MCP runtime: {err}. Reinstall LLM Wiki or ensure Node.js is available."
            );
            let status = status_for(
                "error",
                host,
                None,
                config.transport_token.is_some(),
                Some(message.clone()),
                Some(log_path.to_string_lossy().into_owned()),
            );
            set_status(&state, status);
            Err(message)
        }
    }
}

pub fn status(app: &AppHandle) -> McpHttpStatus {
    let state = app.state::<McpHttpState>();
    if let Ok(mut child_guard) = state.child.lock() {
        if let Some(child) = child_guard.as_mut() {
            if let Ok(Some(exit)) = child.try_wait() {
                *child_guard = None;
                if let Ok(mut status) = state.status.lock() {
                    status.state = "error".to_string();
                    status.pid = None;
                    let log_tail = status
                        .log_path
                        .as_deref()
                        .map(Path::new)
                        .and_then(read_log_tail);
                    status.message = Some(match log_tail {
                        Some(tail) if !tail.trim().is_empty() => {
                            format!("HTTP MCP process exited: {exit}. {tail}")
                        }
                        _ => format!("HTTP MCP process exited: {exit}"),
                    });
                    return status.clone();
                }
            }
        }
    }
    state
        .status
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| status_for("error", "127.0.0.1", None, false, Some("HTTP MCP status is unavailable".to_string()), None))
}

pub fn resolve_mcp_entry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = Path::new("mcp-server").join("dist").join("src").join("index.js");
    let mut candidates = Vec::new();

    let mut push_repo_candidates = |base: PathBuf| {
        candidates.push(base.join(&relative));
        candidates.push(base.join("..").join(&relative));
        candidates.push(base.join("..").join("..").join(&relative));
    };

    push_repo_candidates(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    if let Ok(cwd) = std::env::current_dir() {
        push_repo_candidates(cwd);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&relative));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(&relative));
            candidates.push(exe_dir.join("..").join("Resources").join(&relative));
        }
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.canonicalize().unwrap_or(candidate))
        .ok_or_else(|| "MCP server entry was not found in the bundled resources.".to_string())
}

fn resolve_node_runtime(app: &AppHandle) -> Option<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let relative = Path::new("mcp-server").join("runtime").join(executable);
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&relative));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(&relative));
            candidates.push(exe_dir.join("..").join("Resources").join(&relative));
        }
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn load_runtime_config(app: &AppHandle) -> RuntimeConfig {
    let persisted = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("app-state.json")).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("apiConfig").cloned())
        .and_then(|value| serde_json::from_value::<PersistedApiConfig>(value).ok())
        .unwrap_or_default();

    let api_token = std::env::var("LLM_WIKI_API_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| persisted.token.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()));

    let transport_token = std::env::var("LLM_WIKI_MCP_AUTH_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| api_token.clone());

    RuntimeConfig {
        api_enabled: persisted.enabled.unwrap_or(true),
        mcp_enabled: persisted.mcp_enabled.unwrap_or(false),
        allow_lan_access: persisted.allow_lan_access.unwrap_or(false),
        api_token,
        transport_token,
    }
}

fn stop_child(state: &McpHttpState) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "HTTP MCP process state is unavailable".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn set_status(state: &McpHttpState, value: McpHttpStatus) {
    if let Ok(mut status) = state.status.lock() {
        *status = value;
    }
}

fn status_for(
    state: &str,
    host: &str,
    pid: Option<u32>,
    auth_configured: bool,
    message: Option<String>,
    log_path: Option<String>,
) -> McpHttpStatus {
    McpHttpStatus {
        state: state.to_string(),
        host: host.to_string(),
        port: MCP_HTTP_PORT,
        mcp_url: format!("http://127.0.0.1:{MCP_HTTP_PORT}{MCP_HTTP_PATH}"),
        health_url: format!("http://127.0.0.1:{MCP_HTTP_PORT}/health"),
        pid,
        auth_configured,
        message,
        log_path,
    }
}

fn preflight_port(host: &str) -> Result<(), String> {
    TcpListener::bind((host, MCP_HTTP_PORT))
        .map(|listener| drop(listener))
        .map_err(|err| {
            format!(
                "HTTP MCP cannot listen on {host}:{MCP_HTTP_PORT}: {err}. Another process may already be using port {MCP_HTTP_PORT}."
            )
        })
}

fn wait_until_ready(child: &mut Child, log_path: &Path) -> Result<(), String> {
    let started = Instant::now();
    let timeout = Duration::from_secs(5);
    let address = SocketAddr::from(([127, 0, 0, 1], MCP_HTTP_PORT));

    loop {
        if let Some(exit) = child
            .try_wait()
            .map_err(|err| format!("Failed to inspect HTTP MCP process: {err}"))?
        {
            let tail = read_log_tail(log_path).unwrap_or_default();
            let detail = if tail.trim().is_empty() {
                String::new()
            } else {
                format!(" {tail}")
            };
            return Err(format!("HTTP MCP process exited during startup: {exit}.{detail}"));
        }

        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return Ok(());
        }

        if started.elapsed() >= timeout {
            let tail = read_log_tail(log_path).unwrap_or_default();
            let detail = if tail.trim().is_empty() {
                String::new()
            } else {
                format!(" {tail}")
            };
            return Err(format!(
                "HTTP MCP did not become ready on 127.0.0.1:{MCP_HTTP_PORT} within 5 seconds.{detail}"
            ));
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn read_log_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).ok()?;
    let tail: String = contents.chars().rev().take(4000).collect::<String>().chars().rev().collect();
    Some(tail.trim().replace('\n', " | "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_uses_fixed_http_mcp_port() {
        let status = status_for("running", "127.0.0.1", Some(42), true, None, None);
        assert_eq!(status.port, 19898);
        assert_eq!(status.mcp_url, "http://127.0.0.1:19898/mcp");
        assert_eq!(status.health_url, "http://127.0.0.1:19898/health");
    }

    #[test]
    fn log_tail_is_compact_for_status_messages() {
        let path = std::env::temp_dir().join(format!(
            "llm-wiki-mcp-http-test-{}.log",
            std::process::id()
        ));
        std::fs::write(&path, "line one\nEADDRINUSE: address already in use 0.0.0.0:19898\n")
            .expect("write log");
        let tail = read_log_tail(&path).expect("read log");
        let _ = std::fs::remove_file(&path);
        assert!(tail.contains("EADDRINUSE"));
        assert!(!tail.contains('\n'));
    }

    #[test]
    fn lan_host_is_selected_from_shared_api_flag() {
        let local = if false { "0.0.0.0" } else { "127.0.0.1" };
        let lan = if true { "0.0.0.0" } else { "127.0.0.1" };
        assert_eq!(local, "127.0.0.1");
        assert_eq!(lan, "0.0.0.0");
    }
}
