use std::io::{Cursor, Write};

use flate2::{Compression, write::ZlibEncoder};
use rayon::ThreadPoolBuilder;
use sha1::{Digest, Sha1};

use super::serve;
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
