//! Create a local lane and publish its object, history and workspace metadata.
use crate::{inspection, recovery, store::Store, workspace::engine::command::outbound};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub struct Plan {
    root: PathBuf,
    scope: String,
    parent_name: Option<String>,
    lane_hash: String,
    history_hash: String,
    lane: Value,
    history: Value,
    documents: Documents,
}

struct Documents {
    index: Value,
    scope_json: Value,
    bitmap: Value,
}

#[derive(Clone, Copy)]
pub struct Options<'a> {
    pub alias: &'a str,
    pub fork_lane_new_scope: bool,
}

impl Plan {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::excessive_nesting,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "Creation validates parent state, objects and metadata before publication"
        )
    )]
    pub fn prepare(
        root: &Path,
        name: &str,
        scope: &str,
        options: Options<'_>,
        mut log: Value,
        lane_hash: &str,
        history_key: &str,
    ) -> io::Result<Self> {
        let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "unsupported lane creation");
        if name == "main"
            || !valid_name(name)
            || !valid_name(options.alias)
            || !valid_scope(scope)
            || history_key.is_empty()
            || lane_hash.len() != 40
            || !lane_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(invalid());
        }
        let mut index: Value = match fs::read(root.join(".bit/index.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                json!({"components":[],"lanes":[]})
            }
            Err(error) => return Err(error),
        };
        let mut scope_json: Value =
            serde_json::from_slice(&fs::read(root.join(".bit/scope.json"))?)?;
        let mut bitmap = recovery::jsonc::parse(&fs::read(root.join(".bitmap"))?)?;
        if scope_json["lanes"]["current"] != "main" {
            return Err(invalid());
        }
        let parent = bitmap.get("_bit_lane").cloned();
        let (parent_name, components, forked_from) = if let Some(parent) = parent {
            let parent_id = &parent["id"];
            let parent_name = parent_id["name"]
                .as_str()
                .ok_or_else(invalid)?
                .to_string();
            let parent_scope = parent_id["scope"].as_str().ok_or_else(invalid)?;
            if scope != parent_scope && !options.fork_lane_new_scope {
                return Err(invalid());
            }
            let row = index["lanes"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .find(|row| row["id"] == *parent_id)
                .ok_or_else(invalid)?;
            let hash = row["hash"].as_str().ok_or_else(invalid)?;
            let parent_lane = outbound::read_object(&root.join(".bit/objects"), hash, "Lane")?;
            let components = parent_lane["components"]
                .as_array()
                .ok_or_else(invalid)?
                .clone();
            let forked_from = if parent["exported"] == true {
                Some(parent_id.clone())
            } else {
                parent_lane.get("forkedFrom").cloned()
            };
            (Some(parent_name), components, forked_from)
        } else {
            for row in index["components"].as_array().ok_or_else(invalid)? {
                let hash = row["hash"].as_str().ok_or_else(invalid)?;
                let model = outbound::read_object(&root.join(".bit/objects"), hash, "Component")?;
                if model["state"]["versions"]
                    .as_object()
                    .is_some_and(|rows| {
                        rows.values()
                            .any(|row| row["local"] == true)
                    })
                {
                    return Err(invalid());
                }
            }
            (None, Vec::new(), None)
        };
        let lanes = index["lanes"].as_array_mut().ok_or_else(invalid)?;
        if lanes
            .iter()
            .any(|row| row["id"]["name"] == name && row["id"]["scope"] == scope)
        {
            return Err(invalid());
        }
        let id = json!({"name":name,"scope":scope});
        let lane_hash = lane_hash.to_owned();
        let history_hash = hash(format!("{lane_hash}:LaneHistory").as_bytes());
        let lane_log = log.as_object_mut().ok_or_else(invalid)?;
        lane_log.shift_remove("message");
        let mut history_log = log.clone();
        history_log["message"] = json!("new lane");
        let history_components = components
            .iter()
            .map(|entry| {
                let component_scope = entry["id"]["scope"].as_str().ok_or_else(invalid)?;
                let component_name = entry["id"]["name"].as_str().ok_or_else(invalid)?;
                let head = entry["head"].as_str().ok_or_else(invalid)?;
                Ok(format!("{component_scope}/{component_name}@{head}"))
            })
            .collect::<io::Result<Vec<_>>>()?;
        let mut lane =
            json!({"name":name,"scope":scope,"components":components,"log":log,"schema":"1.0.0"});
        if let Some(forked_from) = forked_from {
            lane["forkedFrom"] = forked_from;
        }
        let history = json!({"name":name,"scope":scope,"laneHash":lane_hash,"history":{history_key:{"log":history_log,"components":history_components,"updateDependents":[]}}});
        lanes.push(json!({"id":id,"hash":lane_hash}));
        let tracking = scope_json["lanes"]["tracking"].as_array_mut().ok_or_else(invalid)?;
        if tracking.iter().any(|row| row["localLane"] == options.alias) {
            return Err(invalid());
        }
        tracking.push(json!({"localLane":options.alias,"remoteLane":name,"remoteScope":scope}));
        scope_json["lanes"]["new"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .push(json!(name));
        bitmap["_bit_lane"] = json!({"id":id,"exported":false});
        Ok(Self {
            root: root.to_path_buf(),
            scope: scope.into(),
            parent_name,
            lane_hash,
            history_hash,
            lane,
            history,
            documents: Documents { index, scope_json, bitmap },
        })
    }

    pub fn commit(&self) -> io::Result<()> {
        let scope = self.root.join(".bit");
        let store = Store::new(scope.join("objects"), None)?;
        for (hash, kind, value) in [
            (&self.lane_hash, "Lane", &self.lane),
            (&self.history_hash, "LaneHistory", &self.history),
        ] {
            store.write(hash, &outbound::encode_object(hash, kind, value)?)?;
        }
        store.finish_batch()?;
        self.documents.publish(&self.root, &store)
    }

    #[must_use]
    pub fn scope(&self) -> &str {
        &self.scope
    }

    #[must_use]
    pub fn parent_name(&self) -> Option<&str> {
        self.parent_name.as_deref()
    }
}

impl Documents {
    fn publish(&self, root: &Path, store: &Store) -> io::Result<()> {
        let mut index = serde_json::to_vec_pretty(&self.index)?;
        index.push(b'\n');
        store.write_index(&index)?;
        let mut scope_json = serde_json::to_vec_pretty(&self.scope_json)?;
        scope_json.push(b'\n');
        fs::write(root.join(".bit/scope.json"), scope_json)?;
        fs::write(root.join(".bitmap"), inspection::render_bitmap(&self.bitmap)?)?;
        Ok(())
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha1::digest(bytes))
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
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
