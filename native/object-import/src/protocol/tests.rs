use std::io::{Cursor, Write};

use flate2::{Compression, write::ZlibEncoder};
use rayon::ThreadPoolBuilder;
use sha1::{Digest, Sha1};

use super::serve_with_store;

fn serve(
    reader: &mut impl std::io::Read,
    writer: &mut impl Write,
    pool: &rayon::ThreadPool,
) -> std::io::Result<()> {
    serve_with_store(reader, writer, pool, None)
}

use crate::validate::validate;

fn object(content: &[u8]) -> ([u8; 20], Vec<u8>) {
    let hash: [u8; 20] = Sha1::digest(content).into();
    let text = format!("{:x}", Sha1::digest(content));
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(format!("Source {text} {}\0", content.len()).as_bytes())
        .unwrap();
    encoder.write_all(content).unwrap();
    (hash, encoder.finish().unwrap())
}

fn request(hash: [u8; 20], compressed: &[u8]) -> Vec<u8> {
    let mut bytes = b"BOI1".to_vec();
    bytes.extend_from_slice(&7_u32.to_be_bytes());
    bytes.extend_from_slice(&1_u32.to_be_bytes());
    bytes.extend_from_slice(&hash);
    bytes.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
    bytes.extend_from_slice(compressed);
    bytes
}

#[test]
fn arbitrary_source_bytes_and_empty_contents_are_verified() {
    for contents in [&b""[..], &b"hello"[..], &b"\0\xff\x00"[..], "unicode \u{1f680}".as_bytes()] {
        let (hash, bytes) = object(contents);
        let outcome = validate(&bytes, hash);
        assert_eq!(outcome.status, "source");
        assert!(outcome.inflated_bytes > contents.len());
    }
}

#[test]
fn chunked_large_sources_do_not_require_full_inflated_buffers() {
    let contents = vec![b'x'; 5 * 1024 * 1024];
    let (hash, bytes) = object(&contents);
    assert_eq!(validate(&bytes, hash).status, "source");
}

#[test]
fn wrong_identity_and_trailing_data_request_legacy() {
    let (hash, mut bytes) = object(b"data");
    assert_eq!(validate(&bytes, [0; 20]).status, "legacy");
    bytes.push(0);
    assert_eq!(validate(&bytes, hash).status, "legacy");
}

#[test]
fn truncated_streams_and_corrupt_checksums_never_validate() {
    let (hash, bytes) = object(b"payload with enough length for truncation");
    for length in 0..bytes.len() {
        assert_eq!(validate(&bytes[..length], hash).status, "legacy", "length {length}");
    }
    let mut corrupt = bytes;
    let last = corrupt.len() - 1;
    corrupt[last] ^= 1;
    assert_eq!(validate(&corrupt, hash).status, "legacy");
}

#[test]
fn binary_frames_are_ordered_and_clean_eof_is_supported() {
    let pool = ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .unwrap();
    let (hash, bytes) = object(b"data");
    let mut input = request(hash, &bytes);
    input.extend(request(hash, &bytes));
    let mut output = Vec::new();
    serve(&mut Cursor::new(input), &mut output, &pool).unwrap();
    let lines: Vec<_> = output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect();
    assert_eq!(lines.len(), 2);
    for line in lines {
        let response: serde_json::Value = serde_json::from_slice(line).unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(response["files"][0]["status"], "source");
    }
}

#[test]
fn partial_or_invalid_frames_fail_without_partial_response() {
    let pool = ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap();
    for input in [b"B".to_vec(), b"bad!".to_vec(), request([0; 20], b"x")[..20].to_vec()] {
        let mut output = Vec::new();
        assert!(serve(&mut Cursor::new(input), &mut output, &pool).is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn persistent_protocol_requires_explicit_verified_source_selection_before_writing() {
    use super::serve_with_store;
    use crate::store::Store;
    use std::fs;
    let directory = std::env::temp_dir().join(format!("bit-source-commit-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let (hash, bytes) = object(b"committed Source");
    let mut input = request(hash, &bytes);
    input[..4].copy_from_slice(b"BOI2");
    let id = u32::from_be_bytes(input[4..8].try_into().unwrap());
    input.extend(b"BOC2");
    input.extend(id.to_be_bytes());
    input.extend(1u32.to_be_bytes());
    input.extend(0u32.to_be_bytes());
    let store = Store::new(directory.clone(), None).unwrap();
    let pool = ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .unwrap();
    let mut output = Vec::new();
    serve_with_store(&mut Cursor::new(input), &mut output, &pool, Some(&store)).unwrap();
    let lines: Vec<_> = output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect();
    assert_eq!(lines.len(), 2);
    let validation: serde_json::Value = serde_json::from_slice(lines[0]).unwrap();
    let commit: serde_json::Value = serde_json::from_slice(lines[1]).unwrap();
    assert_eq!(validation["version"], 2);
    assert_eq!(commit["persisted"], serde_json::json!([0]));
    let hex = validation["files"][0]["hash"].as_str().unwrap();
    assert_eq!(
        fs::read(
            directory
                .join(&hex[..2])
                .join(&hex[2..])
        )
        .unwrap(),
        bytes,
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_commit_indices_are_rejected_before_any_write() {
    use super::selection;
    use crate::validate::Outcome;
    let source =
        Outcome { status: "source", hash: "a".repeat(40), inflated_bytes: 12, reason: None };
    let legacy = Outcome {
        status: "legacy",
        hash: "b".repeat(40),
        inflated_bytes: 0,
        reason: Some("mutable"),
    };
    for indices in [vec![1_u32], vec![0, 0], vec![0, 2]] {
        let mut input = b"BOC2".to_vec();
        input.extend(7_u32.to_be_bytes());
        input.extend((indices.len() as u32).to_be_bytes());
        for index in indices {
            input.extend(index.to_be_bytes());
        }
        assert!(selection(&mut Cursor::new(input), 7, &[source.clone(), legacy.clone()]).is_err());
    }
    let mut wrong_id = b"BOC2".to_vec();
    wrong_id.extend(8_u32.to_be_bytes());
    wrong_id.extend(0_u32.to_be_bytes());
    assert!(selection(&mut Cursor::new(wrong_id), 7, &[source]).is_err());
}
