//! External target directory linking (`bit link --target <dir> [--peers]`).

use super::runner::format_component_id;
use bit_install::{
    config::{DEPENDENCY_RESOLVER_ASPECT, WorkspaceConfig, aspect_id_without_version},
    model::WorkspaceComponent,
};
use serde_json::Value;
use std::{fs, io, path::Path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LinkDetail {
    pub package_name: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LinkToDirResult {
    pub component_id: String,
    pub links_detail: LinkDetail,
}

pub(super) fn link_to_target(
    root: &Path,
    target_dir: &Path,
    ws_config: &WorkspaceConfig,
    selected: &[&WorkspaceComponent],
    include_peers: bool,
) -> io::Result<Vec<LinkToDirResult>> {
    let mut results = Vec::new();
    for &component in selected {
        if component.root_dir == "." {
            continue;
        }
        let from = root.join("node_modules").join(&component.package_name);
        let to = target_dir.join("node_modules").join(&component.package_name);
        create_dir_symlink(&from, &to)?;
        results.push(LinkToDirResult {
            component_id: format_component_id(&component.id),
            links_detail: LinkDetail {
                package_name: component.package_name.clone(),
                from: from.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
            },
        });
    }
    if include_peers {
        let peers = collect_peers(root, ws_config, selected);
        for peer_name in peers {
            let from = root.join("node_modules").join(&peer_name);
            let to = target_dir.join("node_modules").join(&peer_name);
            create_dir_symlink(&from, &to)?;
            results.push(LinkToDirResult {
                component_id: peer_name.clone(),
                links_detail: LinkDetail {
                    package_name: peer_name,
                    from: from.to_string_lossy().into_owned(),
                    to: to.to_string_lossy().into_owned(),
                },
            });
        }
    }
    Ok(results)
}

fn collect_peers(
    root: &Path,
    ws_config: &WorkspaceConfig,
    selected: &[&WorkspaceComponent],
) -> Vec<String> {
    let mut peers = Vec::new();
    for &component in selected {
        if component.root_dir == "." {
            continue;
        }
        let nm_pkg_json = root
            .join("node_modules")
            .join(&component.package_name)
            .join("package.json");
        add_package_json_peers(&nm_pkg_json, &mut peers);
        add_package_json_peers(&component.dir.join("package.json"), &mut peers);
        if let Some(dep_cfg) = component.config.get(DEPENDENCY_RESOLVER_ASPECT)
            && let Some(policy) = dep_cfg.get("policy")
        {
            add_policy_peers(policy, &mut peers);
        }
        add_env_peers(&component.env_id, &mut peers);
    }
    add_policy_peers(&ws_config.dependency_resolver.policy, &mut peers);
    peers
}

fn add_package_json_peers(path: &Path, peers: &mut Vec<String>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if let Some(Value::Object(peer_map)) = json.get("peerDependencies") {
        for key in peer_map.keys() {
            push_unique(peers, key);
        }
    }
}

fn add_policy_peers(policy: &Value, peers: &mut Vec<String>) {
    let Some(peer_deps) = policy.get("peerDependencies") else {
        return;
    };
    match peer_deps {
        Value::Object(map) => add_object_peers(map, peers),
        Value::Array(items) => add_array_peers(items, peers),
        _ => {}
    }
}

fn add_object_peers(map: &serde_json::Map<String, Value>, peers: &mut Vec<String>) {
    for (name, val) in map {
        if val.as_str() != Some("-") {
            push_unique(peers, name);
        }
    }
}

fn add_array_peers(items: &[Value], peers: &mut Vec<String>) {
    for item in items {
        if let Some(name) = item.get("name").and_then(Value::as_str)
            && item.get("version").and_then(Value::as_str) != Some("-")
        {
            push_unique(peers, name);
        }
    }
}

fn add_env_peers(env_id: &str, peers: &mut Vec<String>) {
    let base_env = aspect_id_without_version(env_id);
    if matches!(
        base_env,
        "teambit.react/react"
            | "teambit.react/react-native"
            | "teambit.mdx/mdx"
            | "teambit.harmony/aspect"
            | "teambit.harmony/envs/core-aspect-env"
            | "teambit.harmony/envs/core-aspect-env-jest",
    ) || base_env.contains("react")
    {
        push_unique(peers, "react");
        push_unique(peers, "react-dom");
    }
}

fn push_unique(list: &mut Vec<String>, item: &str) {
    if !item.is_empty()
        && !list
            .iter()
            .any(|existing| existing == item)
    {
        list.push(item.to_owned());
    }
}

fn create_dir_symlink(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = to.symlink_metadata() {
        if meta.is_dir() && !meta.file_type().is_symlink() {
            fs::remove_dir_all(to)?;
        } else {
            fs::remove_file(to)?;
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(from, to)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(from, to)
    }
}
