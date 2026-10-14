//! Freeze the ordinary current lane, its component models, and the local
//! Version closure before the export transaction starts.
use super::{Prepare, invalid, model, remote};
use crate::transfer;
use bit_client_transfer::tar::ObjectItem;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::{collections::HashSet, fs, io, path::Path};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_OBJECTS: usize = 4096;

pub(super) struct LaneSelected {
    pub(super) scope: String,
    pub(super) name: String,
    pub(super) hash: String,
    pub(super) history_hash: String,
    pub(super) lane: Value,
    pub(super) objects: Vec<ObjectItem>,
    pub(super) component_ids: Vec<String>,
    pub(super) expected_ids: Vec<String>,
    pub(super) models: Vec<model::ModelBytes>,
}

pub(super) fn select(input: &Prepare) -> io::Result<Option<LaneSelected>> {
    let bitmap = crate::recovery::jsonc::parse(&fs::read(input.root.join(".bitmap"))?)?;
    let Some(current) = bitmap.get("_bit_lane") else {
        return Ok(None);
    };
    if !input.ids.is_empty() || input.options.resume.is_some() {
        return Err(invalid("outbound lane explicit ids or resume"));
    }
    let scope = current["id"]["scope"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("outbound lane scope"))?
        .to_owned();
    let name = current["id"]["name"]
        .as_str()
        .filter(|value| !value.is_empty() && *value != "main")
        .ok_or_else(|| invalid("outbound lane name"))?
        .to_owned();
    let index: Value = serde_json::from_slice(&fs::read(input.root.join(".bit/index.json"))?)?;
    let lane_row = index["lanes"]
        .as_array()
        .ok_or_else(|| invalid("outbound lane index"))?
        .iter()
        .find(|row| row["id"]["scope"] == scope && row["id"]["name"] == name)
        .ok_or_else(|| invalid("outbound current lane missing"))?;
    let hash = lane_row["hash"]
        .as_str()
        .ok_or_else(|| invalid("outbound lane hash"))?
        .to_owned();
    let dir = input.root.join(".bit/objects");
    let lane = model::read_object(&dir, &hash, "Lane")?;
    if lane["scope"] != scope || lane["name"] != name {
        return Err(invalid("outbound lane identity"));
    }
    if lane
        .get("readmeComponent")
        .is_some_and(|value| !value.is_null())
        || lane
            .get("forkedFrom")
            .is_some_and(|value| !value.is_null())
        || lane["updateDependents"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    {
        return Err(invalid("outbound complex lane export"));
    }
    let history_hash =
        crate::validate::hexadecimal(&Sha1::digest(format!("{hash}:LaneHistory").as_bytes()));
    let history = model::read_object(&dir, &history_hash, "LaneHistory")?;
    if history["scope"] != scope || history["name"] != name || history["laneHash"] != hash {
        return Err(invalid("outbound LaneHistory identity"));
    }
    let rows = lane["components"].as_array().ok_or_else(|| invalid("outbound lane components"))?;
    if rows.len() > MAX_OBJECTS {
        return Err(invalid("outbound lane component budget"));
    }
    let component_rows =
        index["components"].as_array().ok_or_else(|| invalid("outbound component index"))?;
    let remote_heads = remote_heads(&input.root, &scope, &name)?;
    let host = remote::configured_host(input, &scope)?;
    let mut seen_ids = HashSet::new();
    let mut component_ids = Vec::new();
    let mut expected_ids = Vec::new();
    let mut models = Vec::new();
    let mut objects = Vec::new();
    let mut seen = HashSet::new();
    let mut budget = 0;
    for entry in rows {
        if entry
            .get("isDeleted")
            .is_some_and(|value| value == true)
        {
            return Err(invalid("outbound deleted lane component"));
        }
        let component_scope = entry["id"]["scope"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("outbound lane component scope"))?;
        let component_name = entry["id"]["name"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("outbound lane component name"))?;
        let head = entry["head"].as_str().ok_or_else(|| invalid("outbound lane head"))?;
        crate::merge_history::hash(head)?;
        let id = format!("{component_scope}/{component_name}");
        if !seen_ids.insert(id.clone()) {
            return Err(invalid("outbound duplicate lane component"));
        }
        let previous_head = remote_heads
            .iter()
            .find(|row| {
                row["id"]["scope"] == component_scope && row["id"]["name"] == component_name
            })
            .and_then(|row| row["head"].as_str());
        if previous_head == Some(head) {
            continue;
        }
        let row = component_rows
            .iter()
            .find(|row| {
                row["id"]["scope"] == component_scope && row["id"]["name"] == component_name
            })
            .ok_or_else(|| invalid("outbound lane component model missing"))?;
        let model_hash =
            row["hash"].as_str().ok_or_else(|| invalid("outbound component model hash"))?;
        let mut component = model::read_object(&dir, model_hash, "Component")?;
        if component["scope"] != component_scope || component["name"] != component_name {
            return Err(invalid("outbound component identity"));
        }
        let before = read_compressed(&dir, model_hash)?;
        model::clear_and_mark_exported(
            &mut component,
            &scope,
            &host,
            &input.transport.export_date,
        )?;
        let after = model::encode(model_hash, "Component", &component)?;
        let versions = lane_versions(&dir, head, previous_head, &scope, &name)?;
        for object in model::collect(&dir, model_hash, &after, &versions)? {
            append(&mut objects, &mut seen, &mut budget, object)?;
        }
        models.push(model::ModelBytes { hash: model_hash.to_owned(), before, after });
        component_ids.push(id.clone());
        expected_ids.push(format!("{id}@{head}"));
    }
    for object_hash in [&history_hash, &hash] {
        let bytes = read_compressed(&dir, object_hash)?;
        // `read_object` above already validated the compressed object's type.
        append(
            &mut objects,
            &mut seen,
            &mut budget,
            ObjectItem { hash: object_hash.clone(), compressed: bytes, scope: None },
        )?;
    }
    Ok(Some(LaneSelected {
        scope,
        name,
        hash,
        history_hash,
        lane,
        objects,
        component_ids,
        expected_ids,
        models,
    }))
}

fn remote_heads(root: &Path, scope: &str, name: &str) -> io::Result<Vec<Value>> {
    if scope.contains('/') || name.contains('/') || scope == ".." || name == ".." {
        return Err(invalid("outbound lane ref path"));
    }
    let path = root
        .join(".bit/refs/remotes")
        .join(scope)
        .join(name);
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn read_compressed(dir: &Path, hash: &str) -> io::Result<Vec<u8>> {
    transfer::object::repository(dir, crate::merge_history::hash(hash)?, MAX_BYTES)
}

/// Keep the lane head and any preceding snaps made on this lane. A main-lane
/// parent is already on the component's home scope and does not need sending.
fn lane_versions(
    dir: &Path,
    head: &str,
    previous_head: Option<&str>,
    scope: &str,
    name: &str,
) -> io::Result<Vec<String>> {
    let mut output = Vec::new();
    let mut pending = vec![head.to_owned()];
    let mut seen = HashSet::new();
    while let Some(hash) = pending.pop() {
        if !seen.insert(hash.clone()) {
            continue;
        }
        if Some(hash.as_str()) == previous_head {
            continue;
        }
        if seen.len() > MAX_OBJECTS {
            return Err(invalid("outbound lane version budget"));
        }
        let version = model::read_object(dir, &hash, "Version")?;
        if version["unrelated"] == true || version["squashed"] == true {
            return Err(invalid("outbound rewritten lane history"));
        }
        let origin = &version["origin"]["lane"];
        if hash != head && (origin["scope"] != scope || origin["name"] != name) {
            continue;
        }
        output.push(hash);
        let parents =
            version["parents"].as_array().ok_or_else(|| invalid("outbound lane parents"))?;
        for parent in parents.iter().rev() {
            let parent = parent.as_str().ok_or_else(|| invalid("outbound lane parent"))?;
            crate::merge_history::hash(parent)?;
            pending.push(parent.to_owned());
        }
    }
    output.reverse();
    Ok(output)
}

fn append(
    objects: &mut Vec<ObjectItem>,
    seen: &mut HashSet<String>,
    budget: &mut usize,
    item: ObjectItem,
) -> io::Result<()> {
    if !seen.insert(item.hash.clone()) {
        return Ok(());
    }
    *budget = budget
        .checked_add(item.compressed.len())
        .ok_or_else(|| invalid("outbound object budget"))?;
    if *budget > MAX_BYTES || objects.len() >= MAX_OBJECTS {
        return Err(invalid("outbound object budget"));
    }
    objects.push(item);
    Ok(())
}
