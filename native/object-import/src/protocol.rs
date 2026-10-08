use std::io::{self, Read, Write};

use rayon::{ThreadPool, prelude::*};
use serde::Serialize;

use crate::{
    store::Store,
    validate::{Outcome, validate},
};

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

pub(crate) fn serve_with_store(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: Option<&Store>,
) -> io::Result<()> {
    loop {
        let mut magic = [0; 4];
        // Clean EOF is valid; a partial frame must never produce partial success.
        if reader.read(&mut magic[..1])? == 0 {
            return Ok(());
        }
        reader.read_exact(&mut magic[1..])?;
        let persistent = persistent_frame(magic, store)?;
        let id = word(reader)?;
        let count = word(reader)?;
        let inputs = batch(reader, count)?;
        let files: Vec<Outcome> = pool.install(|| {
            inputs
                .par_iter()
                .map(|input| validate(&input.compressed, input.expected))
                .collect()
        });
        respond(
            writer,
            &Response { version: if persistent { 2 } else { 1 }, id, files: files.clone() },
        )?;
        if persistent {
            commit(
                reader,
                writer,
                pool,
                store.ok_or_else(|| invalid("missing native store"))?,
                id,
                &inputs,
                &files,
            )?;
        }
    }
}

#[cfg(test)]
mod tests;

#[derive(Serialize)]
struct CommitResponse {
    version: u8,
    id: u32,
    persisted: Vec<u32>,
    failed: Vec<u32>,
}

fn commit(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: &Store,
    id: u32,
    inputs: &[Input],
    files: &[Outcome],
) -> io::Result<()> {
    let indices = selection(reader, id, files)?;
    let outcomes: Vec<_> = pool.install(|| {
        indices
            .par_iter()
            .map(|index| {
                let offset = *index as usize;
                (
                    *index,
                    store
                        .write(&files[offset].hash, &inputs[offset].compressed)
                        .is_ok(),
                )
            })
            .collect()
    });
    store.finish_batch()?;
    let response = CommitResponse {
        version: 2,
        id,
        persisted: outcomes
            .iter()
            .filter_map(|(index, success)| success.then_some(*index))
            .collect(),
        failed: outcomes
            .iter()
            .filter_map(|(index, success)| (!success).then_some(*index))
            .collect(),
    };
    respond(writer, &response)
}

fn selection(reader: &mut impl Read, id: u32, files: &[Outcome]) -> io::Result<Vec<u32>> {
    let mut magic = [0; 4];
    reader.read_exact(&mut magic)?;
    if magic != *b"BOC2" || word(reader)? != id {
        return Err(invalid("invalid Source commit identity"));
    }
    let count = word(reader)?;
    if count as usize > files.len() {
        return Err(invalid("invalid Source commit count"));
    }
    let mut indices = Vec::new();
    for _ in 0..count {
        let index = word(reader)?;
        if index as usize >= files.len()
            || files[index as usize].status != "source"
            || indices.contains(&index)
        {
            return Err(invalid("invalid Source commit selection"));
        }
        indices.push(index);
    }
    Ok(indices)
}

fn persistent_frame(magic: [u8; 4], store: Option<&Store>) -> io::Result<bool> {
    let persistent = magic == *b"BOI2";
    if magic != *b"BOI1" && (!persistent || store.is_none()) {
        return Err(invalid("unsupported object-import protocol"));
    }
    Ok(persistent)
}

fn respond(writer: &mut impl Write, response: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}
