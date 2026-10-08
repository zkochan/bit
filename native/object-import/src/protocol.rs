use std::io::{self, Read, Write};

use rayon::{ThreadPool, prelude::*};
use serde::Serialize;

use crate::validate::{Outcome, validate};

pub(crate) const MAX_BATCH_BYTES: usize = 128 * 1024 * 1024;
const MAX_FILES: u32 = 16;

struct Input {
    expected: [u8; 20],
    compressed: Vec<u8>,
}

#[derive(Serialize)]
struct Response {
    version: u8,
    id: u32,
    files: Vec<Outcome>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn word(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

fn batch(reader: &mut impl Read, count: u32) -> io::Result<Vec<Input>> {
    if !(1..=MAX_FILES).contains(&count) {
        return Err(invalid("batch count out of bounds"));
    }
    let mut inputs = Vec::new();
    let mut total = 0;
    for _ in 0..count {
        let mut expected = [0; 20];
        reader.read_exact(&mut expected)?;
        let length = word(reader)? as usize;
        total += length;
        if length == 0 || total > MAX_BATCH_BYTES {
            return Err(invalid("compressed batch bytes out of bounds"));
        }
        let mut compressed = Vec::new();
        compressed
            .try_reserve_exact(length)
            .map_err(|_| invalid("unable to reserve compressed input"))?;
        compressed.resize(length, 0);
        reader.read_exact(&mut compressed)?;
        inputs.push(Input { expected, compressed });
    }
    Ok(inputs)
}

pub(crate) fn serve(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
) -> io::Result<()> {
    loop {
        let mut magic = [0; 4];
        // Clean EOF is valid; a partial frame must never produce partial success.
        if reader.read(&mut magic[..1])? == 0 {
            return Ok(());
        }
        reader.read_exact(&mut magic[1..])?;
        if magic != *b"BOI1" {
            return Err(invalid("unsupported object-import protocol"));
        }
        let id = word(reader)?;
        let count = word(reader)?;
        let inputs = batch(reader, count)?;
        let files = pool.install(|| {
            inputs
                .par_iter()
                .map(|input| validate(&input.compressed, input.expected))
                .collect()
        });
        serde_json::to_writer(&mut *writer, &Response { version: 1, id, files })?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
}

#[cfg(test)]
mod tests;
