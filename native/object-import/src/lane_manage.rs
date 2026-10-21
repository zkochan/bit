//! Publish a local, unexported lane rename or remote-scope change.
use crate::{inspection, recovery, store::Store, workspace::engine::command::outbound};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy)]
pub enum Change<'a> {
    Rename(&'a str),
    Scope(&'a str),
}

pub struct Plan {
    root: PathBuf,
    original: Original,
    objects: Objects,
    documents: Documents,
}

struct Original {
    name: String,
    scope: String,
}
struct Objects {
    lane_hash: String,
    history_hash: String,
    lane: Value,
    history: Value,
}
struct Documents {
    index: Value,
    scope_json: Value,
    bitmap: Value,
}

impl Plan {
    pub fn prepare(
        root: &Path,
        change: Change<'_>,
        log: Value,
        history_key: &str,
    ) -> io::Result<Self> {
        if history_key.is_empty() {
            return Err(invalid());
        }
        let mut documents = Documents::read(root)?;
        let original = documents.current()?;
        let lane_hash = documents.lane_hash(&original)?;
        let mut objects = Objects::read(root, &lane_hash, &original)?;
        let (new_name, new_scope, message) = documents.change(change, &original)?;
        objects.change(&new_name, &new_scope, log, &message, history_key)?;
        Ok(Self { root: root.into(), original, objects, documents })
    }

    pub fn commit(&self) -> io::Result<()> {
        let store = Store::new(bit_workspace_config::scope_path(&self.root).join("objects"), None)?;
        self.objects.persist(&store)?;
        self.documents.persist(&self.root, &store)
    }

    #[must_use]
    pub fn old_name(&self) -> &str {
        &self.original.name
    }
    #[must_use]
    pub fn old_scope(&self) -> &str {
        &self.original.scope
    }
}

pub enum ReadmePlan {
    NoReadme(String),
    Remove(Box<ReadmeRemoval>),
}

pub struct ReadmeRemoval {
    root: PathBuf,
    label: String,
    objects: Objects,
    bitmap: Value,
}

impl ReadmeRemoval {
    #[must_use]
    pub fn label(&self) -> &str {
        &self.label
    }
}

impl ReadmePlan {
    pub fn prepare(
        root: &Path,
        lane_name: Option<&str>,
        mut log: Value,
        history_key: &str,
    ) -> io::Result<Self> {
        if history_key.is_empty() {
            return Err(invalid());
        }
        let documents = Documents::read(root)?;
        let (current_name, current_scope) = documents.current_or_default()?;
        let label = lane_name.unwrap_or(&current_name).to_owned();
        let (target_name, target_scope) = match lane_name {
            Some(name) => documents.resolve_lane_id(name)?,
            None => (current_name, current_scope),
        };
        if target_name == "main" {
            return Ok(Self::NoReadme(label));
        }
        let target = Original { name: target_name, scope: target_scope };
        let Ok(lane_hash) = documents.lane_hash(&target) else {
            return Ok(Self::NoReadme(label));
        };
        let mut objects = Objects::read(root, &lane_hash, &target)?;
        let Some(readme) = objects.lane
            .get("readmeComponent")
            .filter(|v| !v.is_null())
            .cloned()
        else {
            return Ok(Self::NoReadme(label));
        };
        let mut bitmap = documents.bitmap;
        remove_readme_from_bitmap(root, &mut bitmap, &target, &readme)?;
        objects.lane
            .as_object_mut()
            .ok_or_else(invalid)?
            .remove("readmeComponent");
        let components = history_components(&objects.lane)?;
        let dependents = objects.lane["updateDependents"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let items = objects.history["history"].as_object_mut().ok_or_else(invalid)?;
        if items.contains_key(history_key) {
            return Err(invalid());
        }
        log["message"] = json!("remove readme");
        items.insert(
            history_key.into(),
            json!({"log":log,"components":components,"updateDependents":dependents}),
        );
        Ok(Self::Remove(Box::new(ReadmeRemoval { root: root.into(), label, objects, bitmap })))
    }

    pub fn commit(&self) -> io::Result<()> {
        let Self::Remove(removal) = self else {
            return Ok(());
        };
        let ReadmeRemoval { root, objects, bitmap, .. } = removal.as_ref();
        let store = Store::new(bit_workspace_config::scope_path(root).join("objects"), None)?;
        objects.persist(&store)?;
        fs::write(root.join(".bitmap"), inspection::render_bitmap(bitmap)?)
    }
}

fn remove_readme_from_bitmap(
    root: &Path,
    bitmap: &mut Value,
    target: &Original,
    readme: &Value,
) -> io::Result<()> {
    let readme_name = readme["id"]["name"].as_str().ok_or_else(invalid)?;
    let readme_scope = readme["id"]["scope"]
        .as_str()
        .filter(|s| !s.is_empty());
    let map = bitmap.as_object_mut().ok_or_else(invalid)?;
    let (_, entry) = map
        .iter_mut()
        .find(|(key, value)| {
            *key != "$schema-version"
                && *key != "_bit_lane"
                && value.is_object()
                && (*key == readme_name
                    || readme_scope.is_some_and(|scope| *key == &format!("{scope}/{readme_name}")))
        })
        .ok_or_else(invalid)?;
    if let Some(root_dir) = entry["rootDir"].as_str()
        && root
            .join(root_dir)
            .join("component.json")
            .exists()
    {
        return Err(invalid());
    }
    let remote_lane_id = format!("{}/{}", target.scope, target.name);
    if let Some(readme_cfg) = entry
        .get_mut("config")
        .and_then(|c| c.get_mut("teambit.lanes/lanes"))
        .and_then(|l| l.get_mut("readme"))
        .and_then(Value::as_object_mut)
    {
        readme_cfg.remove(&remote_lane_id);
    }
    Ok(())
}

impl Documents {
    fn read(root: &Path) -> io::Result<Self> {
        Ok(Self {
            index: serde_json::from_slice(&fs::read(
                bit_workspace_config::scope_path(root).join("index.json"),
            )?)?,
            scope_json: serde_json::from_slice(&fs::read(
                bit_workspace_config::scope_path(root).join("scope.json"),
            )?)?,
            bitmap: recovery::jsonc::parse(&fs::read(root.join(".bitmap"))?)?,
        })
    }

    fn current(&self) -> io::Result<Original> {
        let id = &self.bitmap["_bit_lane"]["id"];
        let name = id["name"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        let scope = id["scope"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        if self.bitmap["_bit_lane"]["exported"] != false
            || !self.scope_json["lanes"]["new"]
                .as_array()
                .is_some_and(|names| names.contains(&json!(name)))
            || self.scope_json["lanes"]["current"] != "main"
        {
            return Err(invalid());
        }
        Ok(Original { name, scope })
    }

    fn current_or_default(&self) -> io::Result<(String, String)> {
        let id = &self.bitmap["_bit_lane"]["id"];
        if let (Some(name), Some(scope)) = (id["name"].as_str(), id["scope"].as_str())
            && !name.is_empty()
            && !scope.is_empty()
        {
            return Ok((name.to_owned(), scope.to_owned()));
        }
        let scope = self.scope_json["name"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        Ok(("main".to_owned(), scope))
    }

    fn resolve_lane_id(&self, name: &str) -> io::Result<(String, String)> {
        if let Some((scope, lane_name)) = name.split_once('/') {
            if scope.is_empty() || lane_name.is_empty() || lane_name.contains('/') {
                return Err(invalid());
            }
            return Ok((lane_name.to_owned(), scope.to_owned()));
        }
        if name == "main" {
            let scope = self.scope_json["name"]
                .as_str()
                .ok_or_else(invalid)?
                .to_owned();
            return Ok(("main".to_owned(), scope));
        }
        if let Some(tracked) = self.scope_json["lanes"]["tracking"]
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row["localLane"] == name)
            })
        {
            let remote_lane = tracked["remoteLane"]
                .as_str()
                .ok_or_else(invalid)?
                .to_owned();
            let remote_scope = tracked["remoteScope"]
                .as_str()
                .ok_or_else(invalid)?
                .to_owned();
            return Ok((remote_lane, remote_scope));
        }
        let matches: Vec<&Value> = self.index["lanes"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .filter(|row| row["id"]["name"] == name)
            .collect();
        let [row] = matches.as_slice() else {
            return Err(invalid());
        };
        let lane_name = row["id"]["name"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        let scope = row["id"]["scope"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        Ok((lane_name, scope))
    }

    fn lane_hash(&self, original: &Original) -> io::Result<String> {
        self.index["lanes"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .find(|row| row["id"] == json!({"name":original.name,"scope":original.scope}))
            .and_then(|row| row["hash"].as_str())
            .map(str::to_owned)
            .ok_or_else(invalid)
    }

    fn change(
        &mut self,
        change: Change<'_>,
        original: &Original,
    ) -> io::Result<(String, String, String)> {
        let (name, scope, message) = match change {
            Change::Rename(name) => self.rename(name, original)?,
            Change::Scope(scope) => self.change_scope(scope, original)?,
        };
        let old_id = json!({"name":original.name,"scope":original.scope});
        let new_id = json!({"name":name,"scope":scope});
        let row = self.index["lanes"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .iter_mut()
            .find(|row| row["id"] == old_id)
            .ok_or_else(invalid)?;
        row["id"] = new_id.clone();
        self.bitmap["_bit_lane"]["id"] = new_id;
        Ok((name, scope, message))
    }

    fn rename(&mut self, name: &str, original: &Original) -> io::Result<(String, String, String)> {
        let tracking = self.scope_json["lanes"]["tracking"].as_array_mut().ok_or_else(invalid)?;
        let duplicate = self.index["lanes"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .any(|row| row["id"]["name"] == name && row["id"]["scope"] == original.scope);
        if !valid_name(name)
            || name == original.name
            || duplicate
            || tracking
                .iter()
                .any(|row| row["localLane"] == name)
        {
            return Err(invalid());
        }
        let tracked = tracking
            .iter_mut()
            .find(|row| row["localLane"] == original.name)
            .ok_or_else(invalid)?;
        tracked["localLane"] = json!(name);
        tracked["remoteLane"] = json!(name);
        let new = self.scope_json["lanes"]["new"].as_array_mut().ok_or_else(invalid)?;
        for value in new
            .iter_mut()
            .filter(|value| **value == original.name)
        {
            *value = json!(name);
        }
        Ok((
            name.into(),
            original.scope.clone(),
            format!(r#"rename lane from "{}" to "{name}""#, original.name),
        ))
    }

    fn change_scope(
        &mut self,
        scope: &str,
        original: &Original,
    ) -> io::Result<(String, String, String)> {
        let duplicate = self.index["lanes"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .any(|row| row["id"]["name"] == original.name && row["id"]["scope"] == scope);
        if !valid_scope(scope) || scope == original.scope || duplicate {
            return Err(invalid());
        }
        let tracked = self.scope_json["lanes"]["tracking"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .iter_mut()
            .find(|row| row["localLane"] == original.name)
            .ok_or_else(invalid)?;
        tracked["remoteScope"] = json!(scope);
        Ok((
            original.name.clone(),
            scope.into(),
            format!("change scope from {} to {scope}", original.scope),
        ))
    }

    fn persist(&self, root: &Path, store: &Store) -> io::Result<()> {
        let mut index = serde_json::to_vec_pretty(&self.index)?;
        index.push(b'\n');
        store.write_index(&index)?;
        fs::write(
            bit_workspace_config::scope_path(root).join("scope.json"),
            serde_json::to_string_pretty(&self.scope_json)?.as_bytes(),
        )?;
        fs::write(root.join(".bitmap"), inspection::render_bitmap(&self.bitmap)?)
    }
}

impl Objects {
    fn read(root: &Path, lane_hash: &str, original: &Original) -> io::Result<Self> {
        let lane = outbound::read_object(
            &bit_workspace_config::scope_path(root).join("objects"),
            lane_hash,
            "Lane",
        )?;
        if lane["name"] != original.name || lane["scope"] != original.scope {
            return Err(invalid());
        }
        Ok(Self {
            lane_hash: lane_hash.into(),
            history_hash: super::lane_history::hash(lane_hash),
            lane,
            history: super::lane_history::read(root, lane_hash)?,
        })
    }

    fn change(
        &mut self,
        name: &str,
        scope: &str,
        mut log: Value,
        message: &str,
        key: &str,
    ) -> io::Result<()> {
        let components = history_components(&self.lane)?;
        let dependents = self.lane["updateDependents"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let items = self.history["history"].as_object_mut().ok_or_else(invalid)?;
        if items.contains_key(key) {
            return Err(invalid());
        }
        log["message"] = json!(message);
        items.insert(
            key.into(),
            json!({"log":log,"components":components,"updateDependents":dependents}),
        );
        self.lane["name"] = json!(name);
        self.lane["scope"] = json!(scope);
        Ok(())
    }

    fn persist(&self, store: &Store) -> io::Result<()> {
        for (hash, kind, value) in [
            (&self.lane_hash, "Lane", &self.lane),
            (&self.history_hash, "LaneHistory", &self.history),
        ] {
            store.write(hash, &outbound::encode_object(hash, kind, value)?)?;
        }
        store.finish_batch()
    }
}

fn history_components(lane: &Value) -> io::Result<Vec<String>> {
    lane["components"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .filter(|component| component["isDeleted"] != true)
        .map(|component| {
            let scope = component["id"]["scope"].as_str().ok_or_else(invalid)?;
            let name = component["id"]["name"].as_str().ok_or_else(invalid)?;
            let head = component["head"].as_str().ok_or_else(invalid)?;
            Ok(format!("{scope}/{name}@{head}"))
        })
        .collect()
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 800
        && value
            .bytes()
            .all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'-' | b'_' | b'$' | b'!')
            })
}
fn valid_scope(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    (parts.len() == 2 || value.len() >= 2) && parts.len() <= 2 && parts.into_iter().all(valid_name)
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "unsupported local lane metadata change")
}
