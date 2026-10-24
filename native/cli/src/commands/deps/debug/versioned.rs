//! Only the plain tagged Node shape is currently safe to render from workspace state.

use super::{Failure, NODE_DEV, WorkspaceDepsContext};
use bit_install::{
    config::DEPENDENCY_RESOLVER_ASPECT,
    model::WorkspaceComponent,
    workspace::{BitmapEntry, ModelData},
};
use serde_json::Value;

pub(super) fn validate(
    ctx: &WorkspaceDepsContext,
    entry: &BitmapEntry,
    component: &WorkspaceComponent,
) -> Result<(), Failure> {
    let decline = || Failure::Declined("configured versioned deps debug delegated".into());
    if component.env_id != "teambit.harmony/node"
        || entry.config
            .as_ref()
            .is_some_and(|config| config.contains_key(DEPENDENCY_RESOLVER_ASPECT))
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
    if !plain_model(&model) {
        return Err(decline());
    }
    Ok(())
}

fn plain_model(model: &ModelData) -> bool {
    if model.extensions
        .iter()
        .any(|extension| {
            extension
                .get("config")
                .and_then(Value::as_object)
                .is_none_or(|config| !config.is_empty())
        })
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
    resolver.next().is_none() && plain_node_dependencies(deps)
}

fn plain_node_dependencies(deps: &[Value]) -> bool {
    deps.len() == NODE_DEV.len()
        && NODE_DEV
            .iter()
            .all(|(name, version)| {
                deps.iter()
                    .any(|dep| {
                        dep.get("id").and_then(Value::as_str) == Some(*name)
                            && dep.get("version").and_then(Value::as_str) == Some(*version)
                            && dep.get("__type").and_then(Value::as_str) == Some("package")
                            && dep.get("lifecycle").and_then(Value::as_str) == Some("dev")
                            && dep.get("source").and_then(Value::as_str) == Some("env")
                    })
            })
}
