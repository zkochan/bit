//! Reuse native links with the final component-load metadata and canonical IO errors.
use bit_install::model::WorkspaceComponent;
use serde_json::Value;
use std::{fs, io, path::Path};

pub(super) fn overlay(components: &mut [WorkspaceComponent], captured: &[Value]) -> io::Result<()> {
    for component in components {
        let Some(row) = captured
            .iter()
            .find(|row| row["identity"] == component.id.to_string_without_version())
        else {
            continue;
        };
        component.files = serde_json::from_value(row["files"].clone())?;
        if let Some(version) = row.get("trackingVersion") {
            component.id.version = version.as_str().map(str::to_owned);
        }
        if let Some(main) = row["current"]["mainFile"].as_str() {
            main.clone_into(&mut component.main_file);
        }
        let extensions = row["current"]["extensions"]
            .as_array()
            .ok_or_else(|| io::Error::other("tracking loaded extensions"))?;
        component.config = bit_install::workspace::aspects::from_model(extensions)
            .into_iter()
            .map(|aspect| (aspect.id, aspect.config))
            .collect();
        component.package_name = bit_install::workspace::component_package_name(
            &component.id,
            row["current"]["bindingPrefix"].as_str(),
            &component.config,
        );
    }
    Ok(())
}

pub(super) fn error(root: &Path, components: &[WorkspaceComponent], error: io::Error) -> io::Error {
    if error.kind() != io::ErrorKind::NotADirectory {
        return error;
    }
    let directory = components
        .iter()
        .map(|component| root.join("node_modules").join(&component.package_name))
        .find(|path| {
            path.ancestors()
                .any(|ancestor| {
                    fs::symlink_metadata(ancestor).is_ok_and(|metadata| metadata.is_file())
                })
        });
    directory.map_or(error, |path| {
        io::Error::other(format!("ENOTDIR: not a directory, mkdir '{}'", path.display()))
    })
}
