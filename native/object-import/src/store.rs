use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

pub(crate) struct Store {
    directory: PathBuf,
    owner: Option<(u32, u32)>,
    counter: AtomicU64,
    written: Mutex<HashMap<String, Arc<Mutex<bool>>>>,
}

impl Store {
    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn new(directory: PathBuf, owner: Option<(u32, u32)>) -> io::Result<Self> {
        if !directory.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "object directory must be absolute",
            ));
        }
        Ok(Self {
            directory,
            owner,
            counter: AtomicU64::new(0),
            written: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn write(&self, hash: &str, compressed: &[u8]) -> io::Result<()> {
        if hash.len() != 40
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid Source identity"));
        }
        let state = Arc::clone(
            self.written
                .lock()
                .map_err(|_| io::Error::other("Source write state poisoned"))?
                .entry(hash.into())
                .or_insert_with(|| Arc::new(Mutex::new(false))),
        );
        let mut completed =
            state.lock().map_err(|_| io::Error::other("Source write state poisoned"))?;
        if *completed {
            return Ok(());
        }
        let path = self.directory
            .join(&hash[..2])
            .join(&hash[2..]);
        let counter = self.counter.fetch_add(1, Ordering::Relaxed);
        let temporary =
            path.with_file_name(format!(".{}.{}.{}", &hash[2..], std::process::id(), counter));
        let result = self.atomic_write(&path, &temporary, compressed);
        if result.is_err() {
            let _cleanup = fs::remove_file(&temporary);
        }
        result?;
        *completed = true;
        Ok(())
    }

    pub(crate) fn exists(&self, hash: &[u8; 20]) -> bool {
        fs::metadata(self.object_path(hash)).is_ok()
    }

    pub(crate) fn object_path(&self, hash: &[u8; 20]) -> PathBuf {
        let identity = crate::validate::hexadecimal(hash);
        self.directory
            .join(&identity[..2])
            .join(&identity[2..])
    }

    pub(crate) fn finish_batch(&self) -> io::Result<()> {
        self.written
            .lock()
            .map_err(|_| io::Error::other("Source write state poisoned"))?
            .clear();
        Ok(())
    }

    fn atomic_write(&self, path: &Path, temporary: &Path, compressed: &[u8]) -> io::Result<()> {
        let existing = fs::metadata(path).ok();
        let mut file = match create(temporary, existing.as_ref()) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(
                    path.parent().ok_or_else(|| io::Error::other("missing object parent"))?,
                )?;
                create(temporary, existing.as_ref())?
            }
            Err(error) => return Err(error),
        };
        file.write_all(compressed)?;
        apply_metadata(temporary, existing.as_ref(), self.owner, caller_is_non_root(&file)?)?;
        drop(file);
        fs::rename(temporary, path)
    }
}

fn create(path: &Path, existing: Option<&fs::Metadata>) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        options.mode(existing.map_or(0o666, MetadataExt::mode));
    }
    #[cfg(not(unix))]
    let _metadata = existing;
    options.open(path)
}

fn caller_is_non_root(file: &fs::File) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(file.metadata()?.uid() != 0)
    }
    #[cfg(not(unix))]
    {
        let _file = file;
        Ok(true)
    }
}

fn acceptable_metadata_error(error: io::Error, non_root: bool) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let unimplemented = error.raw_os_error() == Some(38);
    #[cfg(target_os = "macos")]
    let unimplemented = error.raw_os_error() == Some(78);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let unimplemented = false;
    if unimplemented || non_root && matches!(error.raw_os_error(), Some(1 | 22)) {
        Ok(())
    } else {
        Err(error)
    }
}

fn apply_metadata(
    path: &Path,
    existing: Option<&fs::Metadata>,
    owner: Option<(u32, u32)>,
    non_root: bool,
) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let owner = owner.or_else(|| existing.map(|metadata| (metadata.uid(), metadata.gid())));
        if let Some((uid, gid)) = owner {
            std::os::unix::fs::chown(path, Some(uid), Some(gid))
                .or_else(|error| acceptable_metadata_error(error, non_root))?;
        }
    }
    #[cfg(not(unix))]
    let _owner = owner;
    if let Some(metadata) = existing {
        fs::set_permissions(path, metadata.permissions())
            .or_else(|error| acceptable_metadata_error(error, non_root))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
