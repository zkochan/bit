//! Original Source and compressed bytes travel together so lazy compatibility
//! reads can verify current disk bytes without inflating the same object twice.
use super::{MAX_BYTES, Request, cache, invalid, repository};
use rayon::{ThreadPool, prelude::*};
use serde_json::{Value, json};
use std::io::{self, Read, Write};
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
type Records = Vec<Option<repository::SourceRecord>>;

pub(crate) fn serve(
    reader: &mut impl Read,
    writer: &mut impl Write,
    state: &mut cache::State,
    pool: &ThreadPool,
) -> io::Result<()> {
    let request = super::request(reader)?;
    match load(&request, state, pool).and_then(|records| encode(&request, records, state)) {
        Ok(output) => {
            writer.write_all(&output)?;
            writer.flush()
        }
        Err(_) => crate::protocol::respond(
            writer,
            &json!({"version":1,"id":request.id,"completed":0,"skipped":[],"failed":true}),
        ),
    }
}
fn load(request: &Request, state: &cache::State, pool: &ThreadPool) -> io::Result<Records> {
    if request.files.len() >= 32
        && pool.current_num_threads() > 1
        && let Ok(records) = parallel(request, state, pool, 64)
            .or_else(|_| parallel(request, state, pool, pool.current_num_threads()))
    {
        return Ok(records);
    }
    serial(request, state)
}
fn parallel(
    request: &Request,
    state: &cache::State,
    pool: &ThreadPool,
    width: usize,
) -> io::Result<Records> {
    let mut records = Vec::with_capacity(request.files.len());
    let mut total = 0;
    for batch in request.files.chunks(width) {
        let share = (MAX_OUTPUT - total) / batch.len();
        let next = pool.install(|| {
            batch
                .par_iter()
                .map(|file| read(request, state, file, share))
                .collect::<io::Result<Records>>()
        })?;
        total += next
            .iter()
            .flatten()
            .map(|record| record.body.len() + record.compressed.len())
            .sum::<usize>();
        if total > MAX_OUTPUT {
            return Err(invalid("checkout capsule byte limit"));
        }
        records.extend(next);
    }
    Ok(records)
}
fn serial(request: &Request, state: &cache::State) -> io::Result<Records> {
    let mut records = Vec::with_capacity(request.files.len());
    let mut total = 0;
    for file in &request.files {
        if file.cached(request, state, false).is_some() {
            records.push(None);
            continue;
        }
        let mut compressed = MAX_BYTES - (MAX_OUTPUT - total);
        let record = repository::read_source_record(
            &request.directory,
            file.hash,
            MAX_OUTPUT - total,
            &mut compressed,
        )?;
        total += record.body.len() + record.compressed.len();
        if total > MAX_OUTPUT {
            return Err(invalid("checkout capsule byte limit"));
        }
        records.push(Some(record));
    }
    Ok(records)
}
fn encode(request: &Request, records: Records, state: &mut cache::State) -> io::Result<Vec<u8>> {
    let mut raw: usize = request.files
        .iter()
        .filter_map(|file| file.cached(request, state, false))
        .map(Vec::len)
        .sum();
    if raw > MAX_BYTES {
        return Err(invalid("checkout capsule raw byte limit"));
    }
    let mut body = Vec::new();
    let mut files = Vec::with_capacity(records.len());
    for (input, record) in request.files.iter().zip(records) {
        let hash = crate::validate::hexadecimal(&input.hash);
        let Some(record) = record else {
            files.push(json!({"hash":hash,"cached":true}));
            continue;
        };
        raw += record.body.len();
        if raw > MAX_BYTES {
            return Err(invalid("checkout capsule raw byte limit"));
        }
        files.push(append(&hash, &record, &mut body)?);
        state.insert(&request.directory, input.hash, record.body);
    }
    let mut output = serde_json::to_vec(&json!({"version":1,"id":request.id,"completed":files.len(),"skipped":[],"failed":false,"binaryBytes":body.len(),"data":{"files":files}})).map_err(io::Error::other)?;
    output.push(b'\n');
    output.extend(body);
    Ok(output)
}
fn append(hash: &str, record: &repository::SourceRecord, body: &mut Vec<u8>) -> io::Result<Value> {
    if body.len() + record.body.len() + record.compressed.len() > MAX_OUTPUT {
        return Err(invalid("checkout capsule byte limit"));
    }
    let row = json!({"hash":hash,"offset":body.len(),"bodySize":record.body.len(),"compressedSize":record.compressed.len()});
    body.extend_from_slice(&record.body);
    body.extend_from_slice(&record.compressed);
    Ok(row)
}

fn read(
    request: &Request,
    state: &cache::State,
    file: &super::Input,
    limit: usize,
) -> io::Result<Option<repository::SourceRecord>> {
    if file.cached(request, state, false).is_some() {
        return Ok(None);
    }
    let mut compressed = MAX_BYTES - limit;
    repository::read_source_record(&request.directory, file.hash, limit, &mut compressed).map(Some)
}
