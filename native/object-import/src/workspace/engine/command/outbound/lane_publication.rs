//! Publish a persisted lane locally only after the remote acknowledges its heads.
use super::{Prepare, invalid, lane_model::LaneSelected};
use crate::store::Store;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub(super) struct Prepared {
    root: PathBuf,
    scope: String,
    name: String,
    expected_ids: HashSet<String>,
    index_before: Vec<u8>,
    lane_before: Vec<u8>,
    history_before: Vec<u8>,
    lane_hash: String,
    history_hash: String,
    models: Vec<Model>,
    bitmap_before: Vec<u8>,
    bitmap_after: Vec<u8>,
    scope_before: Vec<u8>,
    scope_after: Vec<u8>,
    refs_before: Option<Vec<u8>>,
    refs_after: Vec<u8>,
    staged_before: Option<Vec<u8>>,
    staged_config_before: Vec<u8>,
    staged_config_after: Vec<u8>,
    file_id: String,
}

struct Model {
    hash: String,
    before: Vec<u8>,
    after: Vec<u8>,
}

pub(super) fn prepare(input: &Prepare, selected: &LaneSelected) -> io::Result<Prepared> {
    let root = &input.root;
    let scope = &selected.scope;
    let name = &selected.name;
    safe_segment(scope)?;
    safe_segment(name)?;
    super::super::bitmap::validate_history_file_id(&input.transport.bitmap_history_file_id)?;
    if selected.lane["scope"] != *scope || selected.lane["name"] != *name {
        return Err(invalid("outbound lane publication identity"));
    }
    let expected_ids = selected.expected_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    if expected_ids.len() != selected.expected_ids.len() {
        return Err(invalid("outbound lane publication acknowledgement"));
    }
    let components = selected.lane["components"]
        .as_array()
        .ok_or_else(|| invalid("outbound lane publication components"))?;
    if components.len() > 4096 {
        return Err(invalid("outbound lane publication bounds"));
    }
    let refs_after = serde_json::to_vec_pretty(components)?;
    let lane_before = object_bytes(root, &selected.hash)?;
    let history_before = object_bytes(root, &selected.history_hash)?;
    let refs_before = read_optional(&refs_path(root, scope, name))?;
    let bitmap_before = fs::read(root.join(".bitmap"))?;
    if bitmap_before.len() > 4 * 1024 * 1024 {
        return Err(invalid("outbound lane bitmap bounds"));
    }
    let bitmap_after = export_bitmap(&bitmap_before, scope, name)?;
    let scope_before = fs::read(root.join(".bit/scope.json"))?;
    if scope_before.len() > 4 * 1024 * 1024 {
        return Err(invalid("outbound lane scope bounds"));
    }
    let scope_after = export_scope(&scope_before, name)?;
    let staged_before = read_optional(&root.join(".bit/staged-snaps"))?;
    if staged_before
        .as_ref()
        .is_some_and(|bytes| bytes.len() > 4 * 1024 * 1024)
    {
        return Err(invalid("outbound lane staged snap bounds"));
    }
    let staged_config_before = fs::read(root.join(".bit/staged-config/main.json"))?;
    let staged_config_after = export_staged_config(&staged_config_before, &expected_ids)?;
    Ok(Prepared {
        root: root.clone(),
        scope: scope.clone(),
        name: name.clone(),
        expected_ids,
        index_before: fs::read(root.join(".bit/index.json"))?,
        lane_before,
        history_before,
        lane_hash: selected.hash.clone(),
        history_hash: selected.history_hash.clone(),
        models: selected.models
            .iter()
            .map(|model| Model {
                hash: model.hash.clone(),
                before: model.before.clone(),
                after: model.after.clone(),
            })
            .collect(),
        bitmap_before,
        bitmap_after,
        scope_before,
        scope_after,
        refs_before,
        refs_after,
        staged_before,
        staged_config_before,
        staged_config_after,
        file_id: input.transport.bitmap_history_file_id.clone(),
    })
}

impl Prepared {
    pub(super) fn commit(self, exported_ids: &[String]) -> io::Result<()> {
        let acknowledged = exported_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        if acknowledged.len() != exported_ids.len() || acknowledged != self.expected_ids {
            return Err(invalid("outbound lane remote acknowledgement"));
        }
        self.validate()?;
        self.publish()
    }

    fn validate(&self) -> io::Result<()> {
        let root = &self.root;
        if fs::read(root.join(".bit/index.json"))? != self.index_before
            || fs::read(root.join(".bitmap"))? != self.bitmap_before
            || fs::read(root.join(".bit/scope.json"))? != self.scope_before
            || read_optional(&refs_path(root, &self.scope, &self.name))? != self.refs_before
            || read_optional(&root.join(".bit/staged-snaps"))? != self.staged_before
            || fs::read(root.join(".bit/staged-config/main.json"))? != self.staged_config_before
            || object_bytes(root, &self.lane_hash)? != self.lane_before
            || object_bytes(root, &self.history_hash)? != self.history_before
        {
            return Err(invalid("outbound lane local state changed"));
        }
        for model in &self.models {
            if model.hash.len() != 40 || !model.hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid("outbound lane model hash"));
            }
            let path = root
                .join(".bit/objects")
                .join(&model.hash[..2])
                .join(&model.hash[2..]);
            if fs::read(path)? != model.before {
                return Err(invalid("outbound lane local model changed"));
            }
        }
        Ok(())
    }

    fn publish(self) -> io::Result<()> {
        let store = Store::new(self.root.join(".bit/objects"), None)?;
        for model in &self.models {
            store.write(&model.hash, &model.after)?;
        }
        write(&refs_path(&self.root, &self.scope, &self.name), &self.refs_after)?;
        fs::write(self.root.join(".bit/staged-config/main.json"), &self.staged_config_after)?;
        if self.staged_before.is_some() {
            fs::remove_file(self.root.join(".bit/staged-snaps"))?;
        }
        fs::write(self.root.join(".bit/scope.json"), &self.scope_after)?;
        if self.bitmap_after != self.bitmap_before {
            self.backup_bitmap()?;
            write(&self.root.join(".bitmap"), &self.bitmap_after)?;
        }
        Ok(())
    }

    fn backup_bitmap(&self) -> io::Result<()> {
        let directory = self.root.join(".bit/bitmap-history");
        fs::create_dir_all(&directory)?;
        fs::write(directory.join(format!(".bitmap-{}", self.file_id)), &self.bitmap_before)?;
        let mut metadata = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join(".bit/bitmap-history-metadata.txt"))?;
        writeln!(metadata, "{} export", self.file_id)?;
        metadata.sync_all()
    }
}

fn export_bitmap(before: &[u8], scope: &str, name: &str) -> io::Result<Vec<u8>> {
    let mut bitmap = crate::recovery::jsonc::parse(before)?;
    let header =
        bitmap.get_mut("_bit_lane").ok_or_else(|| invalid("outbound lane bitmap header"))?;
    if header["id"]["name"] != name
        || header["id"]["scope"] != scope
        || header
            .get("exported")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err(invalid("outbound lane bitmap identity"));
    }
    if header["exported"] == true {
        return Ok(before.to_vec());
    }
    header["exported"] = Value::Bool(true);
    crate::inspection::render_bitmap(&bitmap)
}

fn export_scope(before: &[u8], name: &str) -> io::Result<Vec<u8>> {
    let mut scope: Value = serde_json::from_slice(before)?;
    let new =
        scope["lanes"]["new"].as_array_mut().ok_or_else(|| invalid("outbound lane scope state"))?;
    if new.len() > 4096 {
        return Err(invalid("outbound lane scope bounds"));
    }
    new.retain(|entry| entry != name);
    let mut output = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut output, formatter);
    serde::Serialize::serialize(&scope, &mut serializer)?;
    Ok(output)
}

fn export_staged_config(before: &[u8], expected_ids: &HashSet<String>) -> io::Result<Vec<u8>> {
    let mut rows: Vec<Value> = serde_json::from_slice(before)?;
    if rows.len() > 4096 {
        return Err(invalid("outbound lane staged configuration bounds"));
    }
    let old_len = rows.len();
    rows.retain(|row| {
        let (Some(scope), Some(name)) = (row["id"]["scope"].as_str(), row["id"]["name"].as_str())
        else {
            return true;
        };
        !expected_ids
            .iter()
            .any(|id| id.starts_with(&format!("{scope}/{name}@")))
    });
    if rows.len() == old_len {
        return Ok(before.to_vec());
    }
    serde_json::to_vec_pretty(&rows).map_err(io::Error::other)
}

fn safe_segment(segment: &str) -> io::Result<()> {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment
            .bytes()
            .any(|byte| matches!(byte, b'/' | b'\\' | 0))
    {
        return Err(invalid("outbound lane ref path"));
    }
    Ok(())
}

fn refs_path(root: &Path, scope: &str, name: &str) -> PathBuf {
    root.join(".bit/refs/remotes")
        .join(scope)
        .join(name)
}

fn object_bytes(root: &Path, hash: &str) -> io::Result<Vec<u8>> {
    if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("outbound lane object hash"));
    }
    fs::read(
        root.join(".bit/objects")
            .join(&hash[..2])
            .join(&hash[2..]),
    )
}

fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(path.parent().ok_or_else(|| invalid("outbound lane write parent"))?)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
