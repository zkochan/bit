use std::io::{self, Read, Write};

use rayon::{ThreadPool, prelude::*};
use serde::Serialize;

use crate::{protocol, store::Store};

const MAX_HASHES: u32 = 4096;

#[derive(Serialize)]
struct Response {
    version: u8,
    id: u32,
    exists: Vec<bool>,
}

pub(crate) fn serve(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: &Store,
) -> io::Result<()> {
    let id = protocol::word(reader)?;
    let count = protocol::word(reader)?;
    if !(1..=MAX_HASHES).contains(&count) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "inventory count out of bounds"));
    }
    let mut hashes = vec![[0; 20]; count as usize];
    for hash in &mut hashes {
        reader.read_exact(hash)?;
    }
    let exists = pool.install(|| {
        hashes
            .par_iter()
            .map(|hash| store.exists(hash))
            .collect()
    });
    protocol::respond(writer, &Response { version: 1, id, exists })
}
