use std::io::{self, Read, Write};

use flate2::{Compression, write::ZlibEncoder};
use rayon::{ThreadPool, prelude::*};
use serde::Serialize;

use crate::{protocol, store::Store, validate::hexadecimal};

const MAX_OBJECT_BYTES: usize = 512 * 1024;
const MAX_OBJECTS: u32 = 16;

struct Input {
    hash: String,
    serialized: Vec<u8>,
}

#[derive(Serialize)]
struct Response {
    version: u8,
    id: u32,
    sizes: Vec<Option<usize>>,
}

pub(crate) fn serve(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: Option<&Store>,
) -> io::Result<()> {
    let store = store.ok_or_else(|| invalid("missing mutable store"))?;
    let id = protocol::word(reader)?;
    let inputs = request(reader)?;
    let sizes = pool.install(|| {
        inputs
            .par_iter()
            .map(|input| persist(store, input).ok())
            .collect()
    });
    store.finish_batch()?;
    protocol::respond(writer, &Response { version: 1, id, sizes })
}

fn request(reader: &mut impl Read) -> io::Result<Vec<Input>> {
    let count = protocol::word(reader)?;
    if !(1..=MAX_OBJECTS).contains(&count) {
        return Err(invalid("mutable count out of bounds"));
    }
    let mut inputs: Vec<Input> = Vec::new();
    for _ in 0..count {
        let mut identity = [0; 20];
        reader.read_exact(&mut identity)?;
        let hash = hexadecimal(&identity);
        let length = protocol::word(reader)? as usize;
        if length == 0
            || length > MAX_OBJECT_BYTES
            || inputs
                .iter()
                .any(|input| input.hash == hash)
        {
            return Err(invalid("mutable bytes or identities out of bounds"));
        }
        let mut serialized = vec![0; length];
        reader.read_exact(&mut serialized)?;
        inputs.push(Input { hash, serialized });
    }
    Ok(inputs)
}

fn persist(store: &Store, input: &Input) -> io::Result<usize> {
    check_header(input)?;
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&input.serialized)?;
    let compressed = encoder.finish()?;
    store.write(&input.hash, &compressed)?;
    Ok(compressed.len())
}

fn check_header(input: &Input) -> io::Result<()> {
    let end = input.serialized
        .iter()
        .position(|byte| *byte == 0)
        .filter(|end| *end < 256)
        .ok_or_else(|| invalid("invalid mutable header"))?;
    let header = std::str::from_utf8(&input.serialized[..end])
        .map_err(|_| invalid("invalid mutable header text"))?;
    let mut parts = header.split(' ');
    if !matches!(parts.next(), Some("Version" | "VersionHistory" | "LaneHistory"))
        || parts.next() != Some(input.hash.as_str())
        || parts
            .next()
            .and_then(|size| size.parse::<usize>().ok())
            .is_none()
        || parts.next().is_some()
    {
        return Err(invalid("unsupported mutable identity or type"));
    }
    Ok(())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
