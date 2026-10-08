use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
};

use rayon::{ThreadPool, prelude::*};
use serde::Serialize;

use crate::{
    protocol,
    read_store::{self, Header},
    store::Store,
};

const MAX_PREFIX_ENTRIES: usize = 65_536;
const MAX_OBJECTS: usize = 1_048_576;
const CHUNK_OBJECTS: usize = 4096;

#[derive(Serialize)]
struct Entry {
    hash: String,
    header: Option<Header>,
}

#[derive(Serialize)]
struct Response<'a> {
    version: u8,
    id: u32,
    sequence: u32,
    headers: bool,
    done: bool,
    fallback: bool,
    objects: &'a [Entry],
}

pub(crate) fn serve(
    reader: &mut impl Read,
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: &Store,
    headers: bool,
) -> io::Result<()> {
    let (id, requested) = request(reader)?;
    let mut response = Response {
        version: 1,
        id,
        sequence: 0,
        headers,
        done: false,
        fallback: false,
        objects: &[],
    };
    if prefixes(store.directory()).as_ref() != Some(&requested) {
        return finish(writer, &mut response, true);
    }
    let complete = traverse(writer, pool, store, &requested, &mut response)?;
    finish(writer, &mut response, !complete)
}

fn traverse(
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: &Store,
    prefixes: &[String],
    response: &mut Response<'_>,
) -> io::Result<bool> {
    let mut total = 0;
    let mut batch = Vec::with_capacity(CHUNK_OBJECTS);
    for prefix in prefixes {
        let Some(hashes) = hashes(&store.directory().join(prefix), prefix) else {
            return Ok(false);
        };
        total += hashes.len();
        if total > MAX_OBJECTS {
            return Ok(false);
        }
        for hash in hashes {
            batch.push(hash);
            if batch.len() == CHUNK_OBJECTS {
                emit(writer, pool, store, response, &mut batch)?;
            }
        }
    }
    emit(writer, pool, store, response, &mut batch)?;
    Ok(true)
}

fn emit(
    writer: &mut impl Write,
    pool: &ThreadPool,
    store: &Store,
    response: &mut Response<'_>,
    batch: &mut Vec<String>,
) -> io::Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let objects = entries(batch, pool, store, response.headers);
    let frame = Response { objects: &objects, ..*response };
    protocol::respond(writer, &frame)?;
    response.sequence += 1;
    batch.clear();
    Ok(())
}

fn finish(writer: &mut impl Write, response: &mut Response<'_>, fallback: bool) -> io::Result<()> {
    response.done = true;
    response.fallback = fallback;
    protocol::respond(writer, response)
}

fn request(reader: &mut impl Read) -> io::Result<(u32, Vec<String>)> {
    let id = protocol::word(reader)?;
    let count = protocol::word(reader)?;
    if !(1..=256).contains(&count) {
        return Err(invalid("directory prefix count out of bounds"));
    }
    let mut prefixes = Vec::new();
    for _ in 0..count {
        let mut bytes = [0; 2];
        reader.read_exact(&mut bytes)?;
        let prefix = std::str::from_utf8(&bytes).map_err(|_| invalid("invalid directory prefix"))?;
        if !hexadecimal(prefix, 2)
            || prefixes
                .last()
                .is_some_and(|last: &String| last.as_str() <= prefix)
        {
            return Err(invalid("invalid or unordered directory prefixes"));
        }
        prefixes.push(prefix.to_owned());
    }
    Ok((id, prefixes))
}

fn prefixes(directory: &Path) -> Option<Vec<String>> {
    let mut prefixes = Vec::new();
    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        if name.starts_with('.') {
            continue;
        }
        let kind = entry.file_type().ok()?;
        if kind.is_file() {
            continue;
        }
        if !kind.is_dir() || !hexadecimal(name, 2) {
            return None;
        }
        prefixes.push(name.to_owned());
    }
    prefixes.sort_unstable_by(|left, right| right.cmp(left));
    Some(prefixes)
}

fn hashes(directory: &Path, prefix: &str) -> Option<Vec<String>> {
    let mut hashes = Vec::new();
    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        if name.starts_with('.') {
            continue;
        }
        if !hexadecimal(name, 38) || hashes.len() == MAX_PREFIX_ENTRIES {
            return None;
        }
        hashes.push(format!("{prefix}{name}"));
    }
    hashes.sort_unstable_by(|left, right| right.cmp(left));
    Some(hashes)
}

fn entries(hashes: &[String], pool: &ThreadPool, store: &Store, headers: bool) -> Vec<Entry> {
    pool.install(|| {
        hashes
            .par_iter()
            .map(|hash| Entry {
                hash: hash.clone(),
                header: if headers {
                    read_store::classify(
                        &store
                            .directory()
                            .join(&hash[..2])
                            .join(&hash[2..]),
                    )
                } else {
                    None
                },
            })
            .collect()
    })
}

fn hexadecimal(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests;
