use super::{Directory, frame, pool, store, store_raw};
use crate::checkout::{cache::State, source_read};
use serde_json::Value;
use std::{io::Cursor, path::Path};
fn response(
    directory: &Path,
    inputs: &[([u8; 20], &Path, u32, u32)],
    state: &mut State,
) -> (Value, Vec<u8>) {
    let mut output = Vec::new();
    source_read::serve(&mut Cursor::new(frame(directory, inputs)), &mut output, state, pool())
        .unwrap();
    let newline = output
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap();
    (serde_json::from_slice(&output[..newline]).unwrap(), output[newline + 1..].to_vec())
}
#[test]
fn source_capsules_keep_raw_crlf_and_compressed_identity_in_complete_binary_output() {
    let directory = Directory::new();
    let body = b"\xef\xbb\xbfraw\r\n";
    let hash = store(&directory.0, body);
    let target = directory.0.join("target");
    let mut state = State::default();
    let (header, bytes) = response(&directory.0, &[(hash, &target, 1, 1)], &mut state);
    assert_eq!(header["completed"], 1);
    assert_eq!(header["binaryBytes"], bytes.len());
    assert_eq!(header["data"]["files"][0]["bodySize"], body.len());
    assert_eq!(&bytes[..body.len()], body);
    assert_eq!(state.get(&directory.0, hash).unwrap(), body);
    assert!(!target.exists());
}
#[test]
fn cached_capsules_have_no_payload_and_unguarded_disk_corruption_still_fails() {
    let directory = Directory::new();
    let hash = store(&directory.0, b"cached");
    let target = directory.0.join("target");
    let mut state = State::default();
    response(&directory.0, &[(hash, &target, 1, 0)], &mut state);
    store_raw(&directory.0, hash, b"corrupt");
    let (header, bytes) = response(&directory.0, &[(hash, &target, 3, 0)], &mut state);
    assert_eq!(header["data"]["files"][0]["cached"], true);
    assert_eq!(header["binaryBytes"], 0);
    assert!(bytes.is_empty());
    let (failed, bytes) = response(&directory.0, &[(hash, &target, 1, 0)], &mut state);
    assert_eq!(failed["failed"], true);
    assert!(bytes.is_empty());
}
#[test]
fn capsule_failure_never_exposes_a_valid_prefix_or_partial_body() {
    let directory = Directory::new();
    let hash = store(&directory.0, b"valid prefix");
    let target = directory.0.join("target");
    let mut state = State::default();
    let (header, bytes) =
        response(&directory.0, &[(hash, &target, 1, 0), ([0; 20], &target, 1, 0)], &mut state);
    assert_eq!(header["completed"], 0);
    assert_eq!(header["failed"], true);
    assert!(bytes.is_empty());
    assert!(!target.exists());
}
#[test]
fn cached_capsules_retain_the_complete_raw_budget() {
    let directory = Directory::new();
    let target = directory.0.join("target");
    let mut state = State::default();
    state.insert(&directory.0, [1; 20], vec![b'x'; 1024 * 1024]);
    let inputs = vec![([1; 20], target.as_path(), 3, 0); 64];
    let (header, bytes) = response(&directory.0, &inputs, &mut state);
    assert_eq!(header["failed"], true);
    assert!(bytes.is_empty());
}

#[test]
fn mixed_size_parallel_capsules_retry_without_losing_offsets_or_raw_bytes() {
    let directory = Directory::new();
    let small = store(&directory.0, &[b'x'; 4096]);
    let large = store(&directory.0, &vec![b'y'; 1024 * 1024]);
    let target = directory.0.join("target");
    let mut inputs = vec![(small, target.as_path(), 1, 0); 64];
    inputs[40].0 = large;
    let (header, bytes) = response(&directory.0, &inputs, &mut State::default());
    assert_eq!(header["completed"], 64);
    assert_eq!(header["binaryBytes"], bytes.len());
    let files = header["data"]["files"].as_array().unwrap();
    let mut offset = 0;
    for file in files {
        assert_eq!(file["offset"], offset);
        offset += file["bodySize"].as_u64().unwrap() + file["compressedSize"].as_u64().unwrap();
    }
    assert_eq!(offset as usize, bytes.len());
    assert_eq!(files[40]["bodySize"], 1024 * 1024);
}
