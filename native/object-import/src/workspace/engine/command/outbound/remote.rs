//! Direct client-side pending transfer and canonical remote server actions.
use super::{Pending, Prepare, Retained, invalid};
use bit_client_transfer::{GlobalConfig, http::Network, remotes::Remote, tar};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Write},
    path::Path,
    process::{Command, Stdio},
};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const FILE_ACTION: &str = "\
const [bitDir, scopePath, name, options] = process.argv.slice(1);\
let api;\
try { api = require(require.resolve('@teambit/legacy.scope-api', { paths: [bitDir] })); }\
catch (error) { process.stderr.write(String(error.message || error)); process.exit(1); }\
Promise.resolve(api.action(scopePath, name, JSON.parse(options))).then(\
  result => process.stdout.write(JSON.stringify(result ?? {})),\
  error => { process.stderr.write(String(error.message || error)); process.exitCode = 1; });";

pub(super) fn host(input: &Prepare, scope: &str) -> io::Result<String> {
    let host = configured_host(input, scope)?;
    match Remote::from_host(&host)? {
        Remote::File(path) => check_file_remote(&path, scope)?,
        Remote::Http(_) => {}
    }
    Ok(host)
}

pub(super) fn configured_host(input: &Prepare, scope: &str) -> io::Result<String> {
    let local: Value = serde_json::from_slice(&fs::read(input.root.join(".bit/scope.json"))?)?;
    if let Some(host) = local["remotes"][scope].as_str() {
        return Ok(host.to_owned());
    }
    let globals: Value = match fs::read(&input.global_remotes_file) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Value::Null,
        Err(error) => return Err(error),
    };
    globals[scope]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid("outbound unconfigured or hub remote"))
}

fn check_file_remote(path: &Path, scope: &str) -> io::Result<()> {
    if !path.is_absolute() || !fs::symlink_metadata(path)?.is_dir() {
        return Err(invalid("outbound file remote path"));
    }
    let config: Value = serde_json::from_slice(&fs::read(path.join("scope.json"))?)?;
    if config["name"] != scope {
        return Err(invalid("outbound file remote scope"));
    }
    Ok(())
}

pub(super) fn push(retained: &Retained, pending: &Pending) -> io::Result<()> {
    check_client_id(&retained.client_id)?;
    match Remote::from_host(&pending.host)? {
        Remote::File(path) => {
            push_file(&path, &pending.scope, &retained.client_id, &pending.objects)
        }
        Remote::Http(url) => push_http(retained, pending, &url),
    }
}

fn check_client_id(client: &str) -> io::Result<()> {
    if client.len() > 128
        || client.is_empty()
        || !client
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(invalid("outbound client id"));
    }
    Ok(())
}

fn push_file(
    path: &Path,
    scope: &str,
    client: &str,
    objects: &[tar::ObjectItem],
) -> io::Result<()> {
    check_file_remote(path, scope)?;
    let parent = path.join("pending-objects");
    fs::create_dir_all(&parent)?;
    if !fs::symlink_metadata(&parent)?.file_type().is_dir() {
        return Err(invalid("outbound pending directory"));
    }
    let pending = parent.join(client);
    fs::create_dir(&pending)?;
    let result = write_pending(&pending, objects);
    if result.is_err() {
        let _ = fs::remove_dir_all(&pending);
    }
    result
}

fn write_pending(pending: &Path, objects: &[tar::ObjectItem]) -> io::Result<()> {
    let mut total = 0usize;
    for object in objects {
        let hash = crate::merge_history::hash(&object.hash)?;
        total = total
            .checked_add(object.compressed.len())
            .ok_or_else(|| invalid("outbound pending budget"))?;
        if total > MAX_BYTES {
            return Err(invalid("outbound pending budget"));
        }
        let digest = crate::validate::hexadecimal(&hash);
        let path = pending
            .join(&digest[..2])
            .join(&digest[2..]);
        fs::create_dir_all(path.parent().ok_or_else(|| invalid("outbound pending parent"))?)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(&object.compressed)?;
    }
    Ok(())
}

fn push_http(retained: &Retained, pending: &Pending, url: &str) -> io::Result<()> {
    let archive = tar::pack(&pending.objects, MAX_BYTES)?;
    let network = network(retained)?;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let result = runtime.block_on(network.push(url, &retained.client_id, archive))?;
    if !result.is_empty() {
        return Err(invalid("outbound unexpected push result"));
    }
    Ok(())
}

/// Use the resumable form of the canonical `ExportValidate` server action.
pub(super) fn validate(retained: &Retained, pending: &Pending) -> io::Result<()> {
    let result = action(
        retained,
        pending,
        "ExportValidate",
        &json!({
            "clientId":retained.client_id,"isResumingExport":true
        }),
    )?;
    if !result.is_object() {
        return Err(invalid("outbound validation result"));
    }
    Ok(())
}

/// Match `persistRemotes`: retry any action failure at most three times.
pub(super) fn persist(retained: &Retained, pending: &Pending) -> io::Result<Vec<String>> {
    let mut last = None;
    for _ in 0..3 {
        match action(retained, pending, "ExportPersist", &json!({"clientId":retained.client_id})) {
            Ok(Value::Array(ids)) => {
                return ids
                    .into_iter()
                    .map(|id| {
                        id.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| invalid("outbound persisted identities"))
                    })
                    .collect();
            }
            Ok(_) => last = Some(invalid("outbound persisted identities")),
            Err(error) => last = Some(error),
        }
    }
    Err(io::Error::other(format!(
        "outbound persist failed: {}: {}",
        pending.scope,
        last.ok_or_else(|| invalid("outbound persist attempts"))?
    )))
}

/// Clean pending objects after push or validate fails. Persist failures retain
/// pending objects for the canonical resume-export recovery flow.
pub(super) fn cleanup(retained: &Retained, pending: &Pending) -> io::Result<()> {
    let result =
        action(retained, pending, "RemovePendingDir", &json!({"clientId":retained.client_id}))?;
    if !result.is_object() {
        return Err(invalid("outbound cleanup result"));
    }
    Ok(())
}

fn action(
    retained: &Retained,
    pending: &Pending,
    name: &str,
    options: &Value,
) -> io::Result<Value> {
    check_client_id(&retained.client_id)?;
    match Remote::from_host(&pending.host)? {
        Remote::File(path) => {
            check_file_remote(&path, &pending.scope)?;
            file_action(retained, &path, name, options)
        }
        Remote::Http(url) => {
            let network = network(retained)?;
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
            runtime.block_on(network.action(&url, name, options))
        }
    }
}

fn file_action(retained: &Retained, path: &Path, name: &str, options: &Value) -> io::Result<Value> {
    let output = Command::new(&retained.network.node_executable)
        .args(["-e", FILE_ACTION])
        .arg(&retained.network.bit_dir)
        .arg(path)
        .arg(name)
        .arg(options.to_string())
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(String::from_utf8_lossy(&output.stderr).trim().to_string()));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| invalid("outbound file action result"))
}

fn network(retained: &Retained) -> io::Result<Network> {
    let config: GlobalConfig =
        match fs::read(retained.network.global_config_dir.join("config.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => GlobalConfig::new(),
            Err(error) => return Err(error),
        };
    let local: Value = serde_json::from_slice(&fs::read(retained.root.join(".bit/scope.json"))?)?;
    let local_name = local["name"].as_str().ok_or_else(|| invalid("outbound local scope"))?;
    Network::new(
        &config,
        &retained.network.bit_version,
        Some(local_name),
        retained.network.auth_token.as_deref(),
    )
}
