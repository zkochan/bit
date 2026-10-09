use crate::{
    protocol,
    store::Store,
    tar_archive::{Archive, Input},
    tar_header::{MAX_EXTENSION, invalid, unsupported},
    validate::{self, Outcome},
};
use rayon::{ThreadPool, prelude::*};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};

#[derive(Serialize)]
struct Record {
    name: String,
    offset: u64,
    size: usize,
    sha1: Option<String>,
    text: Option<String>,
    validation: Option<Outcome>,
}
#[derive(Serialize)]
struct Response<'a> {
    version: u8,
    id: u32,
    sequence: u32,
    done: bool,
    fallback: bool,
    error: Option<String>,
    files: &'a [Record],
}
#[derive(Serialize)]
struct Commit {
    version: u8,
    id: u32,
    sequence: u32,
    persisted: Vec<u32>,
    failed: Vec<u32>,
}
pub(crate) fn serve(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: Option<&Store>,
) -> io::Result<()> {
    let (id, flags, path) = request(reader)?;
    let mut archive = Archive::open(&path)?;
    let mut sequence = 0;
    loop {
        let batch = archive.batch();
        let files = records(&batch.inputs, pool, flags)?;
        if !files.is_empty() {
            send(
                writer,
                &Response {
                    version: 1,
                    id,
                    sequence,
                    done: false,
                    fallback: false,
                    error: None,
                    files: &files,
                },
            )?;
            commit(reader, writer, pool, store, (id, sequence), &batch.inputs, &files)?;
            sequence += 1;
        }
        if batch.done {
            let fallback = batch.terminal
                .as_ref()
                .is_some_and(|error| error.kind() != io::ErrorKind::InvalidData);
            let error = batch.terminal.filter(|_| !fallback).map(|error| error.to_string());
            return send(
                writer,
                &Response { version: 1, id, sequence, done: true, fallback, error, files: &[] },
            );
        }
    }
}
fn request(reader: &mut impl Read) -> io::Result<(u32, u32, PathBuf)> {
    let id = protocol::word(reader)?;
    let flags = protocol::word(reader)?;
    let length = protocol::word(reader)? as usize;
    if id == 0 || flags > 3 || !(1..=4096).contains(&length) {
        return Err(invalid("invalid tar request"));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    let path = String::from_utf8(bytes).map_err(|_| invalid("invalid tar path"))?;
    Ok((id, flags, path.into()))
}
fn identity(name: &str) -> Option<[u8; 20]> {
    let hash = name.split('/').nth(1).unwrap_or(name);
    if hash.len() != 40
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut result = [0; 20];
    for (slot, pair) in result
        .iter_mut()
        .zip(hash.as_bytes().chunks_exact(2))
    {
        *slot = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(result)
}
fn record(input: &Input, flags: u32) -> io::Result<Record> {
    let marker = matches!(input.name.as_str(), ".BIT.START" | ".BIT.END" | ".BIT.ERROR");
    if marker && input.bytes.len() > MAX_EXTENSION {
        return Err(unsupported());
    }
    Ok(Record {
        name: input.name.clone(),
        offset: input.offset,
        size: input.bytes.len(),
        sha1: (flags & 1 != 0).then(|| validate::hexadecimal(&Sha1::digest(&input.bytes))),
        text: marker.then(|| String::from_utf8_lossy(&input.bytes).into_owned()),
        validation: identity(&input.name)
            .map(|hash| {
                if flags & 2 != 0 {
                    validate::validate_with_metadata(&input.bytes, hash)
                } else {
                    validate::validate(&input.bytes, hash)
                }
            }),
    })
}
fn records(inputs: &[Input], pool: &ThreadPool, flags: u32) -> io::Result<Vec<Record>> {
    let mut files: Vec<Record> = pool.install(|| {
        inputs
            .par_iter()
            .map(|input| record(input, flags))
            .collect::<io::Result<_>>()
    })?;
    let mut remaining = 512 * 1024;
    for file in &mut files {
        let Some(value) = &mut file.validation else {
            continue;
        };
        let Some(metadata) = &value.metadata else {
            continue;
        };
        if metadata.len() <= remaining {
            remaining -= metadata.len();
        } else {
            value.status = "legacy";
            value.reason = Some("metadata-response-limit");
            value.inflated_bytes = 0;
            value.metadata = None;
        }
    }
    Ok(files)
}
fn selection(
    reader: &mut impl Read,
    identity: (u32, u32),
    files: &[Record],
) -> io::Result<Vec<u32>> {
    let mut magic = [0; 4];
    reader.read_exact(&mut magic)?;
    let actual = (protocol::word(reader)?, protocol::word(reader)?);
    let count = protocol::word(reader)?;
    if magic != *b"BTC1" || actual != identity || count as usize > files.len() {
        return Err(invalid("invalid tar commit identity"));
    }
    let mut selected = Vec::new();
    for _ in 0..count {
        let index = protocol::word(reader)?;
        let source = files
            .get(index as usize)
            .and_then(|file| file.validation.as_ref());
        if selected.contains(&index) || source.is_none_or(|source| source.status != "source") {
            return Err(invalid("invalid tar Source selection"));
        }
        selected.push(index);
    }
    Ok(selected)
}
fn commit(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: Option<&Store>,
    identity: (u32, u32),
    inputs: &[Input],
    files: &[Record],
) -> io::Result<()> {
    let selected = selection(reader, identity, files)?;
    if !selected.is_empty() && store.is_none() {
        return Err(invalid("missing tar Source store"));
    }
    let outcomes: Vec<_> = pool.install(|| {
        selected
            .par_iter()
            .map(|index| {
                let offset = *index as usize;
                let success = persist(store, &inputs[offset], &files[offset]);
                (*index, success)
            })
            .collect()
    });
    if let Some(store) = store {
        store.finish_batch()?;
    }
    let response = Commit {
        version: 1,
        id: identity.0,
        sequence: identity.1,
        persisted: outcomes
            .iter()
            .filter_map(|(index, success)| success.then_some(*index))
            .collect(),
        failed: outcomes
            .iter()
            .filter_map(|(index, success)| (!success).then_some(*index))
            .collect(),
    };
    protocol::respond(writer, &response)
}
fn persist(store: Option<&Store>, input: &Input, file: &Record) -> bool {
    let Some(store) = store else {
        return false;
    };
    let Some(source) = file.validation.as_ref() else {
        return false;
    };
    store.write(&source.hash, &input.bytes).is_ok()
}
fn send(writer: &mut impl Write, response: &Response<'_>) -> io::Result<()> {
    let bytes = serde_json::to_vec(response)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(unsupported());
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()
}
#[cfg(test)]
mod tests;
