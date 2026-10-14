//! `bit install` orchestration.

use crate::{Host, HostInfo, InstallOptions};
use std::{io, path::Path};

/// What the command did, for the final summary line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallSummary {
    pub components: usize,
}

/// Run `bit install` in the workspace at `root`.
pub async fn run(
    root: &Path,
    options: &InstallOptions,
    info: &HostInfo,
    host: &dyn Host,
) -> io::Result<InstallSummary> {
    let _ = (root, options, info, host);
    Err(io::Error::other("native install is not implemented yet"))
}
