//! A deliberately narrow grammar for switching to local lane state. Remote
//! fetches, merge strategies and partial switches stay with the Node CLI.

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub lane: String,
    pub verbose: bool,
    pub force_ours: bool,
    pub force_theirs: bool,
}

pub fn parse(args: &[&str]) -> Option<Options> {
    let mut lane = None;
    let mut skip_fetch = false;
    let mut skip_install = false;
    let mut verbose = false;
    let mut force_ours = false;
    let mut force_theirs = false;
    for arg in args {
        match *arg {
            "--skip-fetch" if !skip_fetch => skip_fetch = true,
            "-x" | "--skip-dependency-installation" if !skip_install => skip_install = true,
            "--verbose" if !verbose => verbose = true,
            "--force-ours" if !force_ours && !force_theirs => force_ours = true,
            "--force-theirs" if !force_theirs && !force_ours => force_theirs = true,
            name if lane.is_none() && valid_lane(name) => lane = Some(name.to_string()),
            _ => return None,
        }
    }
    Some(Options { lane: lane?, verbose, force_ours, force_theirs })
        .filter(|_| skip_fetch && skip_install)
}

fn valid_lane(lane: &str) -> bool {
    !lane.is_empty()
        && !lane.starts_with('-')
        && lane.len() <= 256
        && !lane.contains("..")
        && lane
            .split('/')
            .all(|part| !part.is_empty() && part.bytes().all(lane_char))
        && lane.split('/').count() <= 2
}

fn lane_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
}

impl Options {
    pub fn request(&self) -> Value {
        json!({
            "lane": {"name": self.lane, "skipFetch": true},
            "skipDependencyInstallation": true,
            "verbose": self.verbose,
            "forceOurs": self.force_ours,
            "forceTheirs": self.force_theirs,
        })
    }
}

#[cfg(test)]
mod options_tests {
    use super::*;

    #[test]
    fn accepts_only_local_full_switches() {
        assert_eq!(parse(&["s/dev", "--skip-fetch", "-x"]).unwrap().lane, "s/dev");
        assert_eq!(parse(&["--skip-fetch", "main", "-x"]).unwrap().lane, "main");
        assert!(parse(&["s/dev", "-x"]).is_none());
        assert!(parse(&["s/dev", "--skip-fetch"]).is_none());
        assert!(parse(&["s/dev", "--skip-fetch", "-x", "--branch"]).is_none());
        assert!(parse(&["s/dev", "--skip-fetch", "-x", "--pattern", "foo"]).is_none());
        assert!(parse(&["s/dev", "--skip-fetch", "-x", "-x"]).is_none());
        assert!(parse(&["s/dev", "--skip-fetch", "-x", "--force-ours"]).unwrap().force_ours);
        assert!(parse(&["s/dev", "--skip-fetch", "-x", "--force-theirs"]).unwrap().force_theirs);
        assert!(
            parse(&["s/dev", "--skip-fetch", "-x", "--force-ours", "--force-theirs"]).is_none()
        );
    }
}
