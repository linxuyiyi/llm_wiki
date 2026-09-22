use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::blocking::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use tokio::runtime::{Builder, Runtime};

use crate::{agent, commands};

const MAX_JSON_BODY: usize = 160 * 1024 * 1024;
const MAX_PROXY_BODY: usize = 128 * 1024 * 1024;
const MAX_PROXY_RESPONSE: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct WebServerConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub web_dir: PathBuf,
}

#[derive(Clone)]
struct WebState {
    data_dir: Arc<PathBuf>,
    projects_dir: Arc<PathBuf>,
    uploads_dir: Arc<PathBuf>,
    web_dir: Arc<PathBuf>,
    store_lock: Arc<Mutex<()>>,
    runtime: Arc<Runtime>,
    http: Client,
    agent_sessions: Arc<agent::session::AgentSessionStore>,
    agent_cancellations: agent::cancel::AgentCancellationRegistry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeRequest {
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreRequest {
    name: String,
    op: String,
    key: Option<String>,
    value: Option<Value>,
    defaults: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadRequest {
    batch_id: String,
    name: String,
    relative_path: String,
    content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebAgentTurnRequest {
    #[serde(default = "default_current_project")]
    project_id: String,
    #[serde(default)]
    llm_config: Option<agent::provider::LlmConfig>,
    request: agent::types::AgentChatRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebAgentCancelRequest {
    #[serde(default = "default_current_project")]
    project_id: String,
    session_id: String,
    #[serde(default)]
    run_id: Option<String>,
}

fn default_current_project() -> String {
    "current".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyFetchRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body_base64: Option<String>,
    #[serde(default)]
    accept_invalid_certs: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyFetchResponse {
    status: u16,
    status_text: String,
    headers: BTreeMap<String, String>,
    body_base64: String,
}

pub fn run(config: WebServerConfig) -> Result<(), String> {
    let data_dir = absolute_dir(&config.data_dir)?;
    let projects_dir = data_dir.join("projects");
    let uploads_dir = data_dir.join("uploads");
    fs::create_dir_all(&projects_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&uploads_dir).map_err(|e| e.to_string())?;

    let runtime = Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .map_err(|e| format!("Failed to initialize async runtime: {e}"))?;

    let state = WebState {
        data_dir: Arc::new(data_dir),
        projects_dir: Arc::new(projects_dir),
        uploads_dir: Arc::new(uploads_dir),
        web_dir: Arc::new(config.web_dir),
        store_lock: Arc::new(Mutex::new(())),
        runtime: Arc::new(runtime),
        agent_sessions: Arc::new(agent::session::AgentSessionStore::default()),
        agent_cancellations: agent::cancel::AgentCancellationRegistry::default(),
        http: Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| format!("Failed to initialize HTTP client: {e}"))?,
    };

    let addr = format!("{}:{}", config.host, config.port);
    let server = Server::http(&addr).map_err(|e| format!("Failed to bind {addr}: {e}"))?;
    eprintln!("[LLM Wiki Web] backend listening on http://{addr}");
    eprintln!("[LLM Wiki Web] data dir: {}", state.data_dir.display());

    for request in server.incoming_requests() {
        let state = state.clone();
        thread::spawn(move || {
            if let Err(err) = handle_request(request, &state) {
                eprintln!("[LLM Wiki Web] request failed: {err}");
            }
        });
    }
    Ok(())
}

fn absolute_dir(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to create '{}': {e}", path.display()))?;
    path.canonicalize()
        .map_err(|e| format!("Failed to resolve '{}': {e}", path.display()))
}

fn handle_request(mut request: Request, state: &WebState) -> Result<(), String> {
    let method = request.method().clone();
    let raw_url = request.url().to_string();
    let (path, query) = split_url(&raw_url);

    if method == Method::Options {
        return respond_empty(request, 204);
    }

    if method == Method::Get && (path == "/health" || path == "/api/v1/health") {
        return respond_json(
            request,
            200,
            json!({
                "ok": true,
                "status": "running",
                "mode": "web",
                "version": env!("CARGO_PKG_VERSION"),
                "webUi": true,
                "api": true,
                "mcpEnabled": true,
                "dataDir": state.data_dir.to_string_lossy(),
                "projectsDir": state.projects_dir.to_string_lossy(),
            }),
        );
    }

    if path == "/api/web/info" && method == Method::Get {
        return respond_json(
            request,
            200,
            json!({
                "ok": true,
                "result": {
                    "dataDir": state.data_dir.to_string_lossy(),
                    "projectsDir": state.projects_dir.to_string_lossy(),
                    "uploadsDir": state.uploads_dir.to_string_lossy(),
                }
            }),
        );
    }

    if path == "/api/web/invoke" && method == Method::Post {
        let body: InvokeRequest = read_json(&mut request, MAX_JSON_BODY)?;
        let result = invoke_command(state, &body.command, &body.args);
        return match result {
            Ok(result) => respond_json(request, 200, json!({ "ok": true, "result": result })),
            Err(err) => respond_json(request, 400, json!({ "ok": false, "error": err })),
        };
    }

    if path == "/api/web/agent/turn" && method == Method::Post {
        let body: WebAgentTurnRequest = read_json(&mut request, MAX_JSON_BODY)?;
        let result = run_agent_turn(state, body, false);
        return match result {
            Ok(result) => respond_json(request, 200, json!({ "ok": true, "result": result })),
            Err(err) => respond_json(request, 502, json!({ "ok": false, "error": err })),
        };
    }

    if path == "/api/web/agent/stream" && method == Method::Post {
        let body: WebAgentTurnRequest = read_json(&mut request, MAX_JSON_BODY)?;
        return respond_agent_stream(request, state, body, false);
    }

    if path == "/api/web/agent/cancel" && method == Method::Post {
        let body: WebAgentCancelRequest = read_json(&mut request, MAX_JSON_BODY)?;
        let result = cancel_agent_turn(state, body);
        return match result {
            Ok(result) => respond_json(request, 200, json!({ "ok": true, "result": result })),
            Err(err) => respond_json(request, 400, json!({ "ok": false, "error": err })),
        };
    }

    if path == "/api/web/store" && method == Method::Post {
        let body: StoreRequest = read_json(&mut request, MAX_JSON_BODY)?;
        let result = handle_store(state, body);
        return match result {
            Ok(result) => respond_json(request, 200, json!({ "ok": true, "result": result })),
            Err(err) => respond_json(request, 400, json!({ "ok": false, "error": err })),
        };
    }

    if path == "/api/web/upload" && method == Method::Post {
        let body: UploadRequest = read_json(&mut request, MAX_JSON_BODY)?;
        let result = handle_upload(state, body);
        return match result {
            Ok(path) => respond_json(request, 200, json!({ "ok": true, "result": { "path": path } })),
            Err(err) => respond_json(request, 400, json!({ "ok": false, "error": err })),
        };
    }

    if path == "/api/web/fetch" && method == Method::Post {
        let body: ProxyFetchRequest = read_json(&mut request, MAX_JSON_BODY)?;
        let result = handle_proxy_fetch(state, body);
        return match result {
            Ok(result) => respond_json(request, 200, json!({ "ok": true, "result": result })),
            Err(err) => respond_json(request, 502, json!({ "ok": false, "error": err })),
        };
    }

    if path == "/api/web/file" && method == Method::Get {
        let params = parse_query(query);
        let target = params.get("path").ok_or_else(|| "Missing path".to_string())?;
        return serve_server_file(request, state, target);
    }

    if path.starts_with("/api/v1/") || path == "/api/v1" {
        return handle_public_api(request, state, &method, &path, query);
    }

    if method == Method::Get {
        return serve_static(request, state, &path);
    }

    respond_json(request, 404, json!({ "ok": false, "error": "Not found" }))
}

fn invoke_command(state: &WebState, command: &str, args: &Value) -> Result<Value, String> {
    match command {
        "agent_list_skills" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(agent::skills::agent_list_skills(project_path))
        }
        "read_file" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::fs::read_file(
                path,
                optional(args, "extractImages")?,
            ))?)
        }
        "write_file" => {
            let path = required_string(args, "path")?;
            ensure_allowed_write(state, &path)?;
            let contents = required_string(args, "contents")?;
            state.runtime.block_on(commands::fs::write_file(path, contents))?;
            Ok(Value::Null)
        }
        "write_file_base64" => {
            let path = required_string(args, "path")?;
            ensure_allowed_write(state, &path)?;
            let base64 = required_string(args, "base64")?;
            state.runtime.block_on(commands::fs::write_file_base64(path, base64))?;
            Ok(Value::Null)
        }
        "write_file_atomic" => {
            let path = required_string(args, "path")?;
            ensure_allowed_write(state, &path)?;
            let contents = required_string(args, "contents")?;
            state.runtime.block_on(commands::fs::write_file_atomic(path, contents))?;
            Ok(Value::Null)
        }
        "apply_text_selection_edit" => {
            let project_path = required_string(args, "projectPath")?;
            let file_path = required_string(args, "filePath")?;
            ensure_allowed(state, &project_path)?;
            ensure_allowed(state, &file_path)?;
            let result = state.runtime.block_on(commands::fs::apply_text_selection_edit(
                project_path,
                file_path,
                required_string(args, "prefix")?,
                required_string(args, "selectedText")?,
                required_string(args, "suffix")?,
                required_string(args, "replacement")?,
            ))?;
            to_value(result)
        }
        "create_missing_wiki_page" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            let result = state.runtime.block_on(commands::fs::create_missing_wiki_page(
                project_path,
                required_string(args, "title")?,
                optional(args, "content")?,
            ))?;
            to_value(result)
        }
        "list_directory" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            let result = state.runtime.block_on(commands::fs::list_directory(
                path,
                optional(args, "includeHidden")?,
                optional(args, "maxDepth")?,
            ))?;
            to_value(result)
        }
        "copy_file" => {
            let source = required_string(args, "source")?;
            let destination = required_string(args, "destination")?;
            ensure_allowed(state, &source)?;
            ensure_allowed_write(state, &destination)?;
            state.runtime.block_on(commands::fs::copy_file(source, destination))?;
            Ok(Value::Null)
        }
        "copy_directory" => {
            let source = required_string(args, "source")?;
            let destination = required_string(args, "destination")?;
            ensure_allowed(state, &source)?;
            ensure_allowed_write(state, &destination)?;
            to_value(state.runtime.block_on(commands::fs::copy_directory(source, destination))?)
        }
        "preprocess_file" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::fs::preprocess_file(path))?)
        }
        "delete_file" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            state.runtime.block_on(commands::fs::delete_file(path))?;
            Ok(Value::Null)
        }
        "find_related_wiki_pages" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(state.runtime.block_on(commands::fs::find_related_wiki_pages(
                project_path,
                required_string(args, "sourceName")?,
            ))?)
        }
        "create_directory" => {
            let path = required_string(args, "path")?;
            ensure_allowed_write(state, &path)?;
            state.runtime.block_on(commands::fs::create_directory(path))?;
            Ok(Value::Null)
        }
        "file_exists" => {
            let path = required_string(args, "path")?;
            if ensure_allowed_write(state, &path).is_err() {
                return Ok(Value::Bool(false));
            }
            to_value(state.runtime.block_on(commands::fs::file_exists(path))?)
        }
        "get_file_modified_time" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::fs::get_file_modified_time(path))?)
        }
        "get_file_size" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::fs::get_file_size(path))?)
        }
        "get_file_md5" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::fs::get_file_md5(path))?)
        }
        "read_file_as_base64" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::fs::read_file_as_base64(path))?)
        }
        "create_project" => {
            let path = required_string(args, "path")?;
            ensure_allowed_write(state, &path)?;
            to_value(commands::project::create_project(required_string(args, "name")?, path)?)
        }
        "open_project" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(commands::project::open_project(path)?)
        }
        "open_project_folder" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            commands::project::open_project(path)?;
            Ok(Value::Null)
        }
        "open_path_in_project" => {
            let project_path = required_string(args, "projectPath")?;
            let target_path = required_string(args, "targetPath")?;
            ensure_allowed(state, &project_path)?;
            ensure_allowed(state, &target_path)?;
            Ok(Value::Null)
        }
        "search_project" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            let result = state.runtime.block_on(commands::search::search_project(
                project_path,
                required_string(args, "query")?,
                optional(args, "topK")?,
                optional(args, "includeContent")?,
                optional(args, "queryEmbedding")?,
                optional(args, "embeddingConfig")?,
            ))?;
            to_value(result)
        }
        "embedding_fetch" => {
            let result = state.runtime.block_on(commands::search::embedding_fetch(
                required_string(args, "text")?,
                required(args, "cfg")?,
                optional(args, "maxRetries")?,
            ))?;
            to_value(result)
        }
        "embedding_fetch_batch" => {
            let result = state.runtime.block_on(commands::search::embedding_fetch_batch(
                required(args, "texts")?,
                required(args, "cfg")?,
            ))?;
            to_value(result)
        }
        "get_page_links" => {
            let project_path = required_string(args, "projectPath")?;
            let file_path = required_string(args, "filePath")?;
            ensure_allowed(state, &project_path)?;
            ensure_allowed(state, &file_path)?;
            to_value(state.runtime.block_on(commands::search::get_page_links(project_path, file_path))?)
        }
        "get_file_history_settings" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(state.runtime.block_on(commands::file_history::get_file_history_settings(project_path))?)
        }
        "set_file_history_settings" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(state.runtime.block_on(commands::file_history::set_file_history_settings(
                project_path,
                required(args, "settings")?,
            ))?)
        }
        "list_file_history" => {
            let project_path = required_string(args, "projectPath")?;
            let file_path = required_string(args, "filePath")?;
            ensure_allowed(state, &project_path)?;
            ensure_allowed(state, &file_path)?;
            to_value(state.runtime.block_on(commands::file_history::list_file_history(project_path, file_path))?)
        }
        "restore_file_history" => {
            let project_path = required_string(args, "projectPath")?;
            let file_path = required_string(args, "filePath")?;
            ensure_allowed(state, &project_path)?;
            ensure_allowed(state, &file_path)?;
            to_value(state.runtime.block_on(commands::file_history::restore_file_history(
                project_path,
                file_path,
                required_string(args, "entryId")?,
            ))?)
        }
        "get_file_history_stats" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(state.runtime.block_on(commands::file_history::get_file_history_stats(project_path))?)
        }
        "clear_file_history" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            state.runtime.block_on(commands::file_history::clear_file_history(project_path))?;
            Ok(Value::Null)
        }
        "extract_pdf_images_cmd" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::extract_images::extract_pdf_images_cmd(path))?)
        }
        "extract_office_images_cmd" => {
            let path = required_string(args, "path")?;
            ensure_allowed(state, &path)?;
            to_value(state.runtime.block_on(commands::extract_images::extract_office_images_cmd(path))?)
        }
        "extract_and_save_pdf_images_cmd" => {
            let source_path = required_string(args, "sourcePath")?;
            let dest_dir = required_string(args, "destDir")?;
            let rel_to = required_string(args, "relTo")?;
            ensure_allowed(state, &source_path)?;
            ensure_allowed_write(state, &dest_dir)?;
            ensure_allowed(state, &rel_to)?;
            to_value(state.runtime.block_on(commands::extract_images::extract_and_save_pdf_images_cmd(
                source_path, dest_dir, rel_to,
            ))?)
        }
        "extract_and_save_office_images_cmd" => {
            let source_path = required_string(args, "sourcePath")?;
            let dest_dir = required_string(args, "destDir")?;
            let rel_to = required_string(args, "relTo")?;
            ensure_allowed(state, &source_path)?;
            ensure_allowed_write(state, &dest_dir)?;
            ensure_allowed(state, &rel_to)?;
            to_value(state.runtime.block_on(commands::extract_images::extract_and_save_office_images_cmd(
                source_path, dest_dir, rel_to,
            ))?)
        }
        "export_project_archive" => {
            let project_path = required_string(args, "projectPath")?;
            let destination = required_string(args, "destination")?;
            ensure_allowed(state, &project_path)?;
            ensure_allowed_write(state, &destination)?;
            state.runtime.block_on(commands::project_maintenance::export_project_archive(project_path, destination))?;
            Ok(Value::Null)
        }
        "import_project_archive" => {
            let archive_path = required_string(args, "archivePath")?;
            let destination = required_string(args, "destination")?;
            ensure_allowed(state, &archive_path)?;
            ensure_allowed_write(state, &destination)?;
            to_value(state.runtime.block_on(commands::project_maintenance::import_project_archive(
                archive_path, destination,
            ))?)
        }
        "rebuild_wiki_index" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(state.runtime.block_on(commands::project_maintenance::rebuild_wiki_index(project_path))?)
        }
        "get_file_change_queue" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(commands::file_sync::get_file_change_queue(project_path)?)
        }
        "start_project_file_watcher" | "rescan_project_files" => {
            Ok(json!({ "queue": { "version": 1, "tasks": [] }, "changedTasks": [] }))
        }
        "stop_project_file_watcher" => Ok(Value::Null),
        "retry_file_change_task" | "ignore_file_change_task" => {
            let project_path = required_string(args, "projectPath")?;
            ensure_allowed(state, &project_path)?;
            to_value(commands::file_sync::get_file_change_queue(project_path)?)
        }
        "api_server_status" => to_value("running"),
        "api_server_reload_config" => to_value("running"),
        "clip_server_status" => to_value("disabled"),
        "mcp_server_entry_path" => to_value("managed-by-web-gateway"),
        "mcp_http_server_status" | "mcp_http_server_reload_config" => Ok(json!({
            "state": "running",
            "host": "unified",
            "port": 0,
            "mcpUrl": "/mcp",
            "healthUrl": "/health",
            "pid": null,
            "authConfigured": false,
            "message": "Managed by LLM Wiki Web gateway"
        })),
        "set_close_behavior" => to_value(required_string(args, "value")?),
        "set_proxy_env" => to_value("proxy settings saved; web requests use the server proxy"),
        other => Err(format!("Web runtime command is not implemented yet: {other}")),
    }
}

fn handle_store(state: &WebState, request: StoreRequest) -> Result<Value, String> {
    validate_store_name(&request.name)?;
    let _guard = state.store_lock.lock().map_err(|_| "Store lock poisoned".to_string())?;
    let path = state.data_dir.join(&request.name);
    let defaults = Value::Object(request.defaults.unwrap_or_default());
    let mut store = read_store(&path, &defaults)?;

    match request.op.as_str() {
        "get" => {
            let key = request.key.ok_or_else(|| "Store get requires key".to_string())?;
            Ok(store.get(&key).cloned().unwrap_or(Value::Null))
        }
        "set" => {
            let key = request.key.ok_or_else(|| "Store set requires key".to_string())?;
            let value = request.value.unwrap_or(Value::Null);
            store.as_object_mut().ok_or_else(|| "Store root must be an object".to_string())?.insert(key, value);
            write_store(&path, &store)?;
            Ok(Value::Null)
        }
        "delete" => {
            let key = request.key.ok_or_else(|| "Store delete requires key".to_string())?;
            let existed = store.as_object_mut().and_then(|obj| obj.remove(&key)).is_some();
            write_store(&path, &store)?;
            Ok(Value::Bool(existed))
        }
        "has" => {
            let key = request.key.ok_or_else(|| "Store has requires key".to_string())?;
            Ok(Value::Bool(store.get(&key).is_some()))
        }
        "keys" => Ok(Value::Array(
            store.as_object().map(|obj| obj.keys().cloned().map(Value::String).collect()).unwrap_or_default()
        )),
        "values" => Ok(Value::Array(
            store.as_object().map(|obj| obj.values().cloned().collect()).unwrap_or_default()
        )),
        "entries" => Ok(Value::Array(
            store.as_object().map(|obj| {
                obj.iter().map(|(key, value)| Value::Array(vec![Value::String(key.clone()), value.clone()])).collect()
            }).unwrap_or_default()
        )),
        "clear" => {
            store = json!({});
            write_store(&path, &store)?;
            Ok(Value::Null)
        }
        "reset" => {
            store = defaults;
            write_store(&path, &store)?;
            Ok(Value::Null)
        }
        "save" => {
            write_store(&path, &store)?;
            Ok(Value::Null)
        }
        other => Err(format!("Unsupported store operation: {other}")),
    }
}

fn handle_upload(state: &WebState, request: UploadRequest) -> Result<String, String> {
    let batch = safe_relative(&request.batch_id)?;
    let relative = safe_relative(if request.relative_path.trim().is_empty() {
        &request.name
    } else {
        &request.relative_path
    })?;
    let target = state.uploads_dir.join(batch).join(relative);
    ensure_allowed_write(state, target.to_string_lossy().as_ref())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = B64.decode(request.content_base64.as_bytes()).map_err(|e| format!("Invalid base64 upload: {e}"))?;
    fs::write(&target, bytes).map_err(|e| format!("Failed to save upload: {e}"))?;
    Ok(target.to_string_lossy().replace('\\', "/"))
}

fn handle_proxy_fetch(state: &WebState, request: ProxyFetchRequest) -> Result<ProxyFetchResponse, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http:// and https:// URLs are supported".to_string());
    }

    let client = if request.accept_invalid_certs {
        Client::builder()
            .danger_accept_invalid_certs(true)
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| e.to_string())?
    } else {
        state.http.clone()
    };

    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {e}"))?;
    let mut builder = client.request(method, url);
    for (key, value) in request.headers {
        if matches!(key.to_ascii_lowercase().as_str(), "host" | "content-length" | "connection") {
            continue;
        }
        builder = builder.header(&key, value);
    }
    if let Some(body) = request.body_base64 {
        let bytes = B64.decode(body.as_bytes()).map_err(|e| format!("Invalid proxy body: {e}"))?;
        if bytes.len() > MAX_PROXY_BODY {
            return Err("Proxy request body too large".to_string());
        }
        builder = builder.body(bytes);
    }

    let response = builder.send().map_err(|e| format!("Upstream request failed: {e}"))?;
    let status = response.status();
    let mut headers = BTreeMap::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_string(), value.to_string());
        }
    }
    let bytes = response.bytes().map_err(|e| format!("Failed to read upstream response: {e}"))?;
    if bytes.len() > MAX_PROXY_RESPONSE {
        return Err("Upstream response too large".to_string());
    }
    Ok(ProxyFetchResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body_base64: B64.encode(bytes),
    })
}

fn handle_public_api(
    request: Request,
    state: &WebState,
    method: &Method,
    path: &str,
    query: &str,
) -> Result<(), String> {
    let parts = path
        .trim_start_matches("/api/v1")
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    match (method, parts.as_slice()) {
        (&Method::Get, ["projects"]) => {
            let (projects, current) = api_projects(state)?;
            respond_json(request, 200, json!({ "ok": true, "projects": projects, "currentProject": current }))
        }
        (&Method::Get, ["projects", project_id, "files"]) => {
            let project = resolve_api_project(state, project_id)?;
            let params = parse_query(query);
            let root = match params.get("root").map(String::as_str).unwrap_or("wiki") {
                "sources" => format!("{}/raw/sources", project["path"].as_str().unwrap_or_default()),
                "all" => project["path"].as_str().unwrap_or_default().to_string(),
                _ => format!("{}/wiki", project["path"].as_str().unwrap_or_default()),
            };
            ensure_allowed(state, &root)?;
            let recursive = params.get("recursive").map(|v| v != "false").unwrap_or(true);
            let nodes = state.runtime.block_on(commands::fs::list_directory(
                root,
                Some(false),
                Some(if recursive { 30 } else { 1 }),
            ))?;
            respond_json(request, 200, json!({ "ok": true, "files": nodes, "truncated": false }))
        }
        (&Method::Get, ["projects", project_id, "files", "content"]) => {
            let project = resolve_api_project(state, project_id)?;
            let params = parse_query(query);
            let rel = params.get("path").ok_or_else(|| "Missing path".to_string())?;
            let target = join_project_path(project["path"].as_str().unwrap_or_default(), rel)?;
            ensure_allowed(state, &target)?;
            let content = state.runtime.block_on(commands::fs::read_file(target.clone(), Some(false)))?;
            respond_json(request, 200, json!({ "ok": true, "path": rel, "content": content }))
        }
        _ => respond_json(request, 404, json!({ "ok": false, "error": "Web API endpoint not implemented yet" })),
    }
}

fn api_projects(state: &WebState) -> Result<(Vec<Value>, Value), String> {
    let path = state.data_dir.join("app-state.json");
    let store = read_store(&path, &json!({}))?;
    let mut projects = Vec::new();

    if let Some(recents) = store.get("recentProjects").and_then(Value::as_array) {
        for project in recents {
            let Some(path) = project.get("path").and_then(Value::as_str) else { continue };
            if ensure_allowed(state, path).is_err() {
                continue;
            }
            let id = project.get("id").and_then(Value::as_str).map(ToOwned::to_owned)
                .or_else(|| read_project_id(path))
                .unwrap_or_else(|| path.to_string());
            let name = project.get("name").and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| Path::new(path).file_name().and_then(|x| x.to_str()).unwrap_or("Project").to_string());
            projects.push(json!({ "id": id, "name": name, "path": path, "current": false }));
        }
    }

    let current = if let Some(last) = store.get("lastProject") {
        let path = last.get("path").and_then(Value::as_str).unwrap_or_default();
        let id = last.get("id").and_then(Value::as_str).map(ToOwned::to_owned)
            .or_else(|| read_project_id(path))
            .unwrap_or_else(|| path.to_string());
        let name = last.get("name").and_then(Value::as_str).unwrap_or("Project");
        let current = json!({ "id": id, "name": name, "path": path, "current": true });
        for project in &mut projects {
            if project.get("path").and_then(Value::as_str) == Some(path) {
                project["current"] = Value::Bool(true);
            }
        }
        current
    } else {
        Value::Null
    };

    Ok((projects, current))
}

fn resolve_api_project(state: &WebState, requested: &str) -> Result<Value, String> {
    let (projects, current) = api_projects(state)?;
    if requested == "current" {
        if current.is_null() {
            return Err("No current project".to_string());
        }
        return Ok(current);
    }
    projects
        .into_iter()
        .find(|project| {
            project.get("id").and_then(Value::as_str) == Some(requested)
                || project.get("path").and_then(Value::as_str) == Some(requested)
        })
        .ok_or_else(|| format!("Project not found: {requested}"))
}

fn read_project_id(project_path: &str) -> Option<String> {
    let raw = fs::read_to_string(Path::new(project_path).join(".llm-wiki/project.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()?.get("id")?.as_str().map(ToOwned::to_owned)
}

fn join_project_path(project_path: &str, relative: &str) -> Result<String, String> {
    let rel = safe_relative(relative)?;
    Ok(Path::new(project_path).join(rel).to_string_lossy().replace('\\', "/"))
}

fn serve_server_file(request: Request, state: &WebState, target: &str) -> Result<(), String> {
    ensure_allowed(state, target)?;
    let bytes = fs::read(target).map_err(|e| format!("Failed to read file: {e}"))?;
    let mime = mime_for_path(Path::new(target));
    respond_bytes(request, 200, bytes, mime, "no-store")
}

fn serve_static(request: Request, state: &WebState, path: &str) -> Result<(), String> {
    let relative = path.trim_start_matches('/');
    let candidate = if relative.is_empty() {
        state.web_dir.join("index.html")
    } else {
        state.web_dir.join(safe_relative(relative)?)
    };

    let target = if candidate.is_file() {
        candidate
    } else {
        state.web_dir.join("index.html")
    };

    if !target.is_file() {
        return respond_json(
            request,
            503,
            json!({ "ok": false, "error": "Web UI is not built. Run npm run build:web." }),
        );
    }

    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    let cache = if target.file_name().and_then(|x| x.to_str()) == Some("index.html") {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    respond_bytes(request, 200, bytes, mime_for_path(&target), cache)
}

fn ensure_allowed(state: &WebState, raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("Web server path must be absolute: {raw}"));
    }
    let canonical = path.canonicalize().map_err(|e| format!("Failed to resolve '{raw}': {e}"))?;
    if !canonical.starts_with(state.data_dir.as_ref()) {
        return Err(format!("Path is outside the configured LLM Wiki data directory: {raw}"));
    }
    Ok(canonical)
}

fn ensure_allowed_write(state: &WebState, raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("Web server path must be absolute: {raw}"));
    }
    if path.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err(format!("Parent traversal is not allowed: {raw}"));
    }
    let mut cursor = path.as_path();
    while !cursor.exists() {
        cursor = cursor.parent().ok_or_else(|| format!("Invalid path: {raw}"))?;
    }
    let resolved = cursor.canonicalize().map_err(|e| format!("Failed to resolve '{raw}': {e}"))?;
    if !resolved.starts_with(state.data_dir.as_ref()) {
        return Err(format!("Path is outside the configured LLM Wiki data directory: {raw}"));
    }
    Ok(path)
}

fn validate_store_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.ends_with(".json")
    {
        return Err("Invalid store name".to_string());
    }
    Ok(())
}

fn read_store(path: &Path, defaults: &Value) -> Result<Value, String> {
    let mut value = if path.is_file() {
        let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    let object = value.as_object_mut().ok_or_else(|| "Store root must be an object".to_string())?;
    if let Some(defaults) = defaults.as_object() {
        for (key, value) in defaults {
            object.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    Ok(value)
}

fn write_store(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn safe_relative(raw: &str) -> Result<PathBuf, String> {
    let normalized = raw.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() || normalized.starts_with('/') || normalized.contains(':') {
        return Err(format!("Expected relative path: {raw}"));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!("Unsafe relative path: {raw}"));
        }
    }
    Ok(path.to_path_buf())
}

fn read_json<T: DeserializeOwned>(request: &mut Request, max: usize) -> Result<T, String> {
    let mut reader = request.as_reader().take(max as u64 + 1);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err("Request body too large".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid JSON: {e}"))
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Missing or invalid argument: {key}"))
}

fn required<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    let value = args.get(key).cloned().ok_or_else(|| format!("Missing argument: {key}"))?;
    serde_json::from_value(value).map_err(|e| format!("Invalid argument {key}: {e}"))
}

fn optional<T: DeserializeOwned>(args: &Value, key: &str) -> Result<Option<T>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| format!("Invalid argument {key}: {e}")),
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn split_url(url: &str) -> (String, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (url.to_string(), ""),
    }
}

fn parse_query(query: &str) -> BTreeMap<String, String> {
    query
        .split('&')
        .filter(|item| !item.is_empty())
        .map(|item| {
            let (key, value) = item.split_once('=').unwrap_or((item, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push((hi << 4) | lo);
                index += 3;
                continue;
            }
        }
        out.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn respond_json(request: Request, status: u16, body: Value) -> Result<(), String> {
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(status));
    response.add_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap());
    add_common_headers(&mut response);
    request.respond(response).map_err(|e| e.to_string())
}

fn respond_empty(request: Request, status: u16) -> Result<(), String> {
    let mut response = Response::empty(StatusCode(status));
    add_common_headers(&mut response);
    request.respond(response).map_err(|e| e.to_string())
}

fn respond_bytes(
    request: Request,
    status: u16,
    bytes: Vec<u8>,
    content_type: &str,
    cache_control: &str,
) -> Result<(), String> {
    let mut response = Response::from_data(bytes).with_status_code(StatusCode(status));
    response.add_header(Header::from_bytes("Content-Type", content_type).unwrap());
    response.add_header(Header::from_bytes("Cache-Control", cache_control).unwrap());
    add_common_headers(&mut response);
    request.respond(response).map_err(|e| e.to_string())
}

fn add_common_headers<R: Read>(response: &mut Response<R>) {
    response.add_header(Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap());
    response.add_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
    response.add_header(Header::from_bytes("Access-Control-Allow-Headers", "Content-Type, Authorization, X-LLM-Wiki-Token").unwrap());
    response.add_header(Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS").unwrap());
}

fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "pdf" => "application/pdf",
        "md" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
