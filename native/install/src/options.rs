//! `bit install` argv parsing.

use serde::{Deserialize, Serialize};

/// Parsed `bit install` flags. Field docs name the CLI flag.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    /// `[packages...]`
    pub packages: Vec<String>,
}
