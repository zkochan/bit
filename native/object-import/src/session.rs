use std::io::{self, Cursor, Read};

/// A workspace protocol session whose state survives individual requests.
/// Callers must serialize requests and wait for outstanding work before replaying it.
pub struct WorkspaceSession {
    pool: rayon::ThreadPool,
    checkout: crate::checkout::cache::State,
    merge: crate::merge_state::State,
    store: Option<crate::store::Store>,
}

impl WorkspaceSession {
    pub fn new(threads: usize) -> io::Result<Self> {
        if !(1..=8).contains(&threads) {
            return Err(io::Error::other("thread count must be between 1 and 8"));
        }
        Ok(Self {
            pool: rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .map_err(io::Error::other)?,
            checkout: crate::checkout::cache::State::default(),
            merge: crate::merge_state::State::default(),
            store: None,
        })
    }

    pub fn with_store(
        threads: usize,
        directory: std::path::PathBuf,
        owner: Option<(u32, u32)>,
    ) -> io::Result<Self> {
        let mut session = Self::new(threads)?;
        session.store = Some(crate::store::Store::new(directory, owner)?);
        Ok(session)
    }

    /// Dispatch one existing workspace frame. An error retires the owning session.
    pub fn request(&mut self, frame: &[u8]) -> io::Result<Vec<u8>> {
        if frame.len() > crate::protocol::MAX_BATCH_BYTES {
            return Err(io::Error::other("workspace frame exceeds byte limit"));
        }
        let mut reader = Cursor::new(frame);
        let mut magic = [0; 4];
        reader.read_exact(&mut magic)?;
        let mut output = Vec::new();
        if !crate::protocol::serve_extension(
            magic,
            &mut reader,
            &mut output,
            &self.pool,
            self.store.as_ref(),
            &mut self.checkout,
            &mut self.merge,
        )? || reader.position() != frame.len() as u64
        {
            return Err(io::Error::other("invalid workspace frame"));
        }
        Ok(output)
    }
}
