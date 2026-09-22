use std::path::PathBuf;

use llm_wiki_lib::web_server::{self, WebServerConfig};

fn main() {
    if let Err(error) = run() {
        eprintln!("LLM Wiki Web server failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let host = value_arg(&args, "--host")
        .or_else(|| std::env::var("LLM_WIKI_WEB_HOST").ok())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = value_arg(&args, "--port")
        .or_else(|| std::env::var("LLM_WIKI_WEB_PORT").ok())
        .unwrap_or_else(|| "8080".to_string())
        .parse::<u16>()
        .map_err(|_| "Invalid --port".to_string())?;

    let data_dir = value_arg(&args, "--data-dir")
        .or_else(|| std::env::var("LLM_WIKI_DATA_DIR").ok())
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir);
    let web_dir = value_arg(&args, "--web-dir")
        .or_else(|| std::env::var("LLM_WIKI_WEB_DIR").ok())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist-web"));

    web_server::run(WebServerConfig {
        host,
        port,
        data_dir,
        web_dir,
    })
}

fn value_arg(args: &[String], name: &str) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if arg == name {
            return args.get(index + 1).cloned();
        }
        if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
            return Some(value.to_string());
        }
    }
    None
}

fn default_data_dir() -> PathBuf {
    if let Ok(value) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(value).join("llm-wiki");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local/share/llm-wiki");
    }
    PathBuf::from("./data/llm-wiki")
}
