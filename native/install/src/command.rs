//! `bit install` orchestration.

use crate::{
    Host, HostInfo,
    options::{self, Parsed},
    output::Sink,
};
use std::{io, path::Path};

/// What the command did, for the final summary line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallSummary {
    pub components: usize,
}

/// The result of one `bit install` invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Installed(InstallSummary),
    /// `--help`: the JavaScript entry point renders Bit's command help.
    Help,
}

/// Run `bit install` with `argv` (starting at the command name) in the
/// workspace containing `cwd`.
pub async fn run(
    cwd: &Path,
    argv: &[String],
    info: &HostInfo,
    host: &dyn Host,
    sink: Sink,
) -> io::Result<Outcome> {
    let options = match options::parse(argv)? {
        Parsed::Help => return Ok(Outcome::Help),
        Parsed::Install(options) => options,
    };
    let _ = (cwd, options, info, host, sink);
    Err(io::Error::other("native install is not implemented yet"))
}
