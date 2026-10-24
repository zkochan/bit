//! Plain built-in environment versions are rendered from verified model dependencies.

use super::{Failure, NODE_DEV, REACT_DEV, REACT_PEER, REACT_RUNTIME, WorkspaceDepsContext};
use bit_install::workspace::{BitmapEntry, ModelData};
use serde_json::{Value, json};

pub(super) fn validate(
    ctx: &WorkspaceDepsContext,
    entry: &BitmapEntry,
) -> Result<&'static str, Failure> {
    let decline = || Failure::Declined("configured versioned deps debug delegated".into());
    if entry.config
        .as_ref()
        .is_some_and(|config| !config.is_empty())
    {
        return Err(decline());
    }
    let mut id = entry.id.clone();
    if id.scope.is_none() {
        id.scope = id.effective_scope().map(str::to_owned);
    }
    let model = ctx.objects
        .component(&id)
        .map_err(|_| decline())?
        .ok_or_else(decline)?;
    let env_id = model_env(&model).ok_or_else(decline)?;
    if !plain_model(&model, env_id) {
        return Err(decline());
    }
    Ok(env_id)
}

fn model_env(model: &ModelData) -> Option<&'static str> {
    let mut envs = model.extensions
        .iter()
        .filter(|extension| extension["name"] == "teambit.envs/envs");
    let id = envs
        .next()?
        .pointer("/data/id")?
        .as_str()?;
    if envs.next().is_some() {
        return None;
    }
    match id {
        "teambit.harmony/node" => Some("teambit.harmony/node"),
        "teambit.react/react" => Some("teambit.react/react"),
        _ => None,
    }
}

fn plain_model(model: &ModelData, env_id: &str) -> bool {
    if model.extensions
        .iter()
        .any(|extension| !allowed_config(extension, env_id))
    {
        return false;
    }
    let mut resolver = model.extensions
        .iter()
        .filter(|extension| {
            extension.get("name").and_then(Value::as_str)
                == Some("teambit.dependencies/dependency-resolver")
        });
    let Some(deps) = resolver
        .next()
        .and_then(|extension| extension.pointer("/data/dependencies"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    resolver.next().is_none() && plain_dependencies(deps, env_id)
}

fn allowed_config(extension: &Value, env_id: &str) -> bool {
    let config = &extension["config"];
    if env_id == "teambit.react/react" {
        match extension["name"].as_str() {
            Some("teambit.react/react") => return config == &json!({"__specific": true}),
            Some("teambit.envs/envs") => {
                return config == &json!({"env": env_id, "__specific": true});
            }
            _ => {}
        }
    }
    config.as_object().is_some_and(serde_json::Map::is_empty)
}

fn plain_dependencies(deps: &[Value], env_id: &str) -> bool {
    let expected = if env_id == "teambit.harmony/node" {
        vec![("dev", NODE_DEV)]
    } else {
        vec![("runtime", REACT_RUNTIME), ("dev", REACT_DEV), ("peer", REACT_PEER)]
    };
    let expected_count: usize = expected
        .iter()
        .map(|(_, group)| group.len())
        .sum();
    deps.len() == expected_count
        && expected
            .iter()
            .all(|(lifecycle, group)| {
                group
                    .iter()
                    .all(|(name, version)| {
                        deps.iter()
                            .any(|dep| {
                                dep.get("id").and_then(Value::as_str) == Some(*name)
                                    && dep.get("version").and_then(Value::as_str) == Some(*version)
                                    && dep.get("__type").and_then(Value::as_str) == Some("package")
                                    && dep.get("lifecycle").and_then(Value::as_str)
                                        == Some(*lifecycle)
                                    && dep.get("source").and_then(Value::as_str) == Some("env")
                                    && dep.get("hidden").and_then(Value::as_bool) == Some(false)
                            })
                    })
            })
}
