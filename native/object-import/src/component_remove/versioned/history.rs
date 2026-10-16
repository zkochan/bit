//! Create the `VersionHistory` that Node status populates before normal lane removal.

use super::{HistoryCreation, invalid, outbound};
use serde_json::json;
use sha1::{Digest, Sha1};
use std::{fs, io, path::Path};

pub(super) fn create(
    root: &Path,
    scope: &str,
    name: &str,
    version: &str,
) -> io::Result<HistoryCreation> {
    let identity = format!("{scope}/{name}:VersionHistory");
    let hash = format!("{:x}", Sha1::digest(identity.as_bytes()));
    let path = root
        .join(".bit/objects")
        .join(&hash[..2])
        .join(&hash[2..]);
    ensure_absent(&path)?;
    let value = json!({"name":name,"scope":scope,"versions":[{"hash":version,"parents":[]}],"graphCompleteRefs":[]});
    let bytes = outbound::encode_object(&hash, "VersionHistory", &value)?;
    Ok(HistoryCreation { path, bytes })
}

pub(super) fn ensure_absent(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(invalid("existing lane VersionHistory is unsupported")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
