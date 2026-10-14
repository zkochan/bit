//! The ordinary merge install follows native no-snap materialization.

use crate::{
    commands::{
        color::Chalk,
        installation::Installer,
        list::bitmap,
        status::js::{array, decline, text},
        workspace_command::{self, Planned, Request, progress::Progress, resolve, results::Report},
    },
    native::Outcome,
};
use bit_install::output::Output;
use serde_json::{Value, json};
use std::{ffi::OsString, io, path::Path};

use super::{options::Options, report};

pub(in crate::commands) fn start(
    root: &Path,
    argv: &[&str],
    skip: bool,
) -> io::Result<Option<Installer>> {
    if skip { Ok(None) } else { Installer::start(root, argv).map(Some) }
}

pub(in crate::commands) fn execute(
    root: &Path,
    args: &[OsString],
    planned: Planned,
    report: Report,
    progress: Option<&Progress>,
    installer: Option<Installer>,
) -> io::Result<Outcome> {
    let Some(installer) = installer else {
        return workspace_command::execute(root, args, "merge", planned, &report, |output| {
            render_progress(output, progress);
        });
    };
    let result = &planned.plan["result"];
    if planned.plan.get("needsSnap").is_some() || result["mergeSnapResults"].is_object() {
        return Ok(Outcome::Declined("merge installation precedes snapping".to_string()));
    }
    let conflicts = result["leftUnresolvedConflicts"] == true;
    workspace_command::execute_then(root, args, "merge", |output| {
        render_progress(output, progress);
        let mut planned = planned;
        workspace_command::commit(&mut planned, root)?;
        if !conflicts && let Err(error) = installer.install_merge(root) {
            output.failure(&format!(
                "failed installing packages, see the log for full stacktrace. error: {error}",
            ));
        }
        Ok(report)
    })
}

fn render_progress(output: &Output, progress: Option<&Progress>) {
    if let Some(progress) = progress {
        progress.render_merge(output);
    }
}

/// Node installs merged files before `snapForMerge`. A no-snap merge followed
/// by the native resolve path retains that ordering within one CLI command.
pub(super) fn execute_snapping(
    root: &Path,
    args: &[OsString],
    options: &Options,
    planned: &Planned,
    progress: Option<&Progress>,
    installer: Option<Installer>,
) -> io::Result<Outcome> {
    let Some(installer) = installer else { return Err(decline("merge snap installer")) };
    let (expected, mut materialized) = match prepare_snapping(root, args, options, planned) {
        Ok(prepared) => prepared,
        Err(error) => return Ok(Outcome::Declined(format!("merge before installation: {error}"))),
    };
    let message = options.message.clone();
    workspace_command::execute_then(root, args, "merge", |output| {
        render_progress(output, progress);
        workspace_command::commit(&mut materialized, root)?;
        if let Err(error) = installer.install_merge(root) {
            output.failure(&format!(
                "failed installing packages, see the log for full stacktrace. error: {error}",
            ));
        }
        let mut resolve = resolve::plan(
            root,
            &resolve::ResolveRequest {
                kind: resolve::Kind::Resolve,
                options: json!({ "message": message }),
                selection: resolve::Selection::Resolve { pattern: None },
            },
        )?;
        let resolved =
            array(resolve.plan["result"].get("resolvedComponents"), "resolved components")?
                .iter()
                .map(|row| text(row.get("id")).map(str::to_string))
                .collect::<io::Result<Vec<_>>>()?;
        if resolved != expected {
            return Err(decline("merge snap selection changed after installation"));
        }
        workspace_command::commit(&mut resolve, root)?;
        let bitmap = bitmap::read(root)?;
        let snapped = expected
            .iter()
            .map(|identity| {
                let version = bitmap.entries
                    .iter()
                    .find(|entry| &entry.identity == identity)
                    .and_then(|entry| entry.version.as_deref())
                    .ok_or_else(|| decline("merge snap bitmap version"))?;
                Ok(json!({ "id": format!("{identity}@{version}") }))
            })
            .collect::<io::Result<Vec<Value>>>()?;
        let mut result = materialized.plan["result"].clone();
        result["mergeSnapResults"] = json!({
            "snappedComponents": snapped,
            "autoSnappedResults": [],
        });
        report::format(
            &result,
            report::Mode { verbose: options.verbose, lane: false },
            Chalk::detect(args),
        )
    })
}

/// Both plans must describe the same merge before any workspace write.
fn prepare_snapping(
    root: &Path,
    args: &[OsString],
    options: &Options,
    planned: &Planned,
) -> io::Result<(Vec<String>, Planned)> {
    if bitmap::read(root)?.lane.is_some() {
        return Err(decline("install-before-snap on a lane"));
    }
    let result = &planned.plan["result"];
    let snap = &result["mergeSnapResults"];
    let expected = array(snap.get("snappedComponents"), "merge snapped components")?
        .iter()
        .map(|row| {
            text(row.get("id"))?
                .rsplit_once('@')
                .map(|(identity, _)| identity.to_string())
                .ok_or_else(|| decline("merge snap identity"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    if expected.is_empty()
        || !array(snap.get("autoSnappedResults"), "merge auto snaps")?.is_empty()
        || !array(result.get("removedComponents"), "merge removed components")?.is_empty()
    {
        return Err(decline("merge snap requires a single-stage merge"));
    }
    let mut no_snap = options.request();
    no_snap["noSnap"] = json!(true);
    no_snap
        .as_object_mut()
        .unwrap()
        .remove("message");
    let request = Request { operation: "merge", options: no_snap, to: None, verify_fresh: true };
    let materialized = workspace_command::plan(root, &request)?;
    let mut before_snap = result.clone();
    before_snap
        .as_object_mut()
        .unwrap()
        .remove("mergeSnapResults");
    if materialized.plan["result"] != before_snap {
        return Err(decline("merge no-snap plan differs before installation"));
    }
    report::format(
        &materialized.plan["result"],
        report::Mode { verbose: options.verbose, lane: false },
        Chalk::detect(args),
    )?;
    Ok((expected, materialized))
}
