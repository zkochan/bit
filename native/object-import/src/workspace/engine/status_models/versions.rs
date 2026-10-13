use super::{Target, invalid};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io,
};

pub(super) fn references(models: &[Value], targets: &[Target]) -> io::Result<Vec<String>> {
    let index: HashMap<_, _> = models
        .iter()
        .map(|model| {
            let scope = model["scope"].as_str().unwrap_or_default();
            let name = model["name"].as_str().unwrap_or_default();
            (if scope.is_empty() { name.to_owned() } else { format!("{scope}/{name}") }, model)
        })
        .collect();
    let mut seen = HashSet::new();
    let mut references = Vec::new();
    for target in targets {
        if target.version.is_empty() {
            continue;
        }
        let Some(model) = index.get(&target.identity) else {
            continue;
        };
        let reference = reference(model, &target.version)?;
        if seen.insert(reference.clone()) {
            references.push(reference);
        }
    }
    Ok(references)
}
pub(super) fn reference(model: &Value, version: &str) -> io::Result<String> {
    if crate::merge_history::hash(version).is_ok() {
        return Ok(version.to_owned());
    }
    model["orphanedVersions"]
        .get(version)
        .unwrap_or_else(|| &model["versions"][version])
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid("status model version absent"))
}
