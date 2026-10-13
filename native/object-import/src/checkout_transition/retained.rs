use super::plan::{Body, State};
use std::{collections::HashMap, path::Path};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    identity: (u64, u64),
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Stamp {
    fn read(path: &Path) -> Option<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::symlink_metadata(path).ok()?;
            metadata
                .is_file()
                .then(|| Self {
                    identity: (metadata.dev(), metadata.ino()),
                    bytes: metadata.len(),
                    modified: (metadata.mtime(), metadata.mtime_nsec()),
                    changed: (metadata.ctime(), metadata.ctime_nsec()),
                })
        }
        #[cfg(not(unix))]
        {
            let _path = path;
            None
        }
    }
}
pub(super) fn capture(bodies: &mut [Body]) {
    let mut stamps = HashMap::new();
    for body in bodies {
        body.stamp = stamps
            .entry(body.path.clone())
            .or_insert_with(|| Stamp::read(&body.path))
            .clone();
    }
}
pub(super) fn read(state: &State, path: &Path, ranges: &[(usize, usize)]) -> Option<Vec<u8>> {
    if ranges.is_empty() || ranges.len() > 4096 || !state.retain_reads {
        return None;
    }
    let total = ranges
        .iter()
        .try_fold(0_usize, |sum, (offset, length)| {
            (offset.checked_add(*length)? <= 32 * 1024 * 1024).then_some(())?;
            sum.checked_add(*length)
                .filter(|bytes| *bytes <= 32 * 1024 * 1024)
        })?;
    let owned = state.plans
        .values()
        .flat_map(|plan| &plan.bodies)
        .find(|body| body.path == path)?;
    let stamp = owned.stamp.as_ref()?;
    if Stamp::read(path).as_ref() != Some(stamp) {
        return None;
    }
    let bodies: HashMap<_, _> = state.plans
        .values()
        .flat_map(|plan| &plan.bodies)
        .filter(|body| body.path == path && body.stamp.as_ref() == Some(stamp))
        .map(|body| ((body.offset.unwrap_or(0), body.contents.len()), body.contents.as_slice()))
        .collect();
    let mut output = Vec::with_capacity(total);
    for range in ranges {
        output.extend_from_slice(bodies.get(range)?);
    }
    (Stamp::read(path).as_ref() == Some(stamp)).then_some(output)
}
