use super::{State, WorkspaceEngine, failure};
use napi::{
    Env, Result,
    bindgen_prelude::{Buffer, Object},
};
use napi_derive::napi;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
};

#[napi]
impl WorkspaceEngine {
    /// A missing or changed spool is a cache miss, never an engine failure.
    #[napi]
    pub fn read_body_ranges<'env>(
        &self,
        env: &'env Env,
        path: String,
        ranges: Buffer,
    ) -> Result<Object<'env>> {
        if path.len() > 32768
            || ranges.is_empty()
            || ranges.len() > 4096 * 8
            || !ranges.len().is_multiple_of(8)
        {
            return Err(failure("invalid retained body range request"));
        }
        let parsed = decode_ranges(&ranges);
        drop(ranges);
        let ranges = parsed;
        let path = PathBuf::from(path);
        if self.state.closed.load(Ordering::Acquire) || self.state.busy.swap(true, Ordering::AcqRel)
        {
            return Err(failure("workspace engine closed or busy"));
        }
        let lease = ReadLease(Arc::clone(&self.state));
        let (deferred, promise) = env.create_deferred::<Option<Buffer>, _>()?;
        self.state.dispatcher.spawn(move || {
            let output = lease.read(&path, &ranges);
            deferred.resolve(move |_| {
                let result = if lease.0.closed.load(Ordering::Acquire) {
                    None
                } else {
                    output.map(Into::into)
                };
                drop(lease);
                Ok(result)
            });
        });
        Ok(promise)
    }
}

struct ReadLease(Arc<State>);
impl Drop for ReadLease {
    fn drop(&mut self) {
        if self.0.closed.load(Ordering::Acquire)
            && let Ok(mut session) = self.0.session.try_lock()
        {
            session.take();
        }
        self.0.busy.store(false, Ordering::Release);
    }
}

fn decode_ranges(bytes: &[u8]) -> Vec<(usize, usize)> {
    bytes
        .chunks_exact(8)
        .map(|range| {
            (
                u32::from_be_bytes(range[..4].try_into().expect("offset")) as usize,
                u32::from_be_bytes(range[4..].try_into().expect("length")) as usize,
            )
        })
        .collect()
}

impl ReadLease {
    fn read(&self, path: &std::path::Path, ranges: &[(usize, usize)]) -> Option<Vec<u8>> {
        if self.0.closed.load(Ordering::Acquire) {
            return None;
        }
        self.0.session
            .try_lock()
            .ok()?
            .as_ref()?
            .read_retained_bodies(path, ranges)
    }
}
