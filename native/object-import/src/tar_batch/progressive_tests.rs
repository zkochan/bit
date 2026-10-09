use super::tests::{Directory, commit, entry, request, serve, source};
use crate::{store::Store, tar_archive::MAX_ARCHIVE};
use flate2::{Compression, write::ZlibEncoder};
use std::io::Write;

fn start(path: &std::path::Path, flags: u32) -> Vec<u8> {
    let mut bytes = request(path);
    bytes[..4].copy_from_slice(b"BTI2");
    bytes[8..12].copy_from_slice(&flags.to_be_bytes());
    bytes
}
fn progress(bytes: &mut Vec<u8>, id: u32, extent: u64, done: u32) {
    bytes.extend_from_slice(b"BTP1");
    bytes.extend_from_slice(&id.to_be_bytes());
    bytes.extend_from_slice(&extent.to_be_bytes());
    bytes.extend_from_slice(&done.to_be_bytes());
}
#[test]
fn sources_are_acknowledged_before_later_progress_and_final_eof() {
    let directory = Directory::new();
    let (hash, body) = source(b"prefix");
    let prefix = entry(&hash, &body, b'0').repeat(16);
    let (other, suffix) = source(b"suffix");
    let path = directory.archive(&[prefix.clone(), entry(&other, &suffix, b'0')].concat());
    let store = Store::new(directory.0.join("objects"), None).unwrap();
    let mut request = start(&path, 3);
    progress(&mut request, 1, prefix.len() as u64, 0);
    commit(&mut request, 0, &[0]);
    progress(&mut request, 1, std::fs::metadata(&path).unwrap().len(), 1);
    commit(&mut request, 1, &[0]);
    let (result, values) = serve(request, Some(&store));
    result.unwrap();
    assert_eq!(
        values[0]["files"]
            .as_array()
            .unwrap()
            .len(),
        16,
    );
    assert_eq!(values[1]["persisted"], serde_json::json!([0]));
    assert_eq!(values[2]["files"][0]["validation"]["hash"], other);
    assert_eq!(values[3]["persisted"], serde_json::json!([0]));
    assert_eq!(values[4]["done"], true);
    for (hash, body) in [(hash, body), (other, suffix)] {
        assert_eq!(
            std::fs::read(
                directory.0
                    .join("objects")
                    .join(&hash[..2])
                    .join(&hash[2..])
            )
            .unwrap(),
            body,
        );
    }
}
#[test]
fn fragmented_declared_prefixes_preserve_metadata_offsets_digest_and_unicode() {
    let directory = Directory::new();
    let hash = "a".repeat(40);
    let text = format!("Version {hash} 0\0{{\"unicode\":\"日本語 🚀\"}}");
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(text.as_bytes()).unwrap();
    let body = encoder.finish().unwrap();
    let bytes = entry(&hash, &body, b'0');
    let path = directory.archive(&bytes);
    let mut request = start(&path, 3);
    for extent in [1, 511, 512, 512 + body.len() as u64] {
        progress(&mut request, 1, extent, 0);
    }
    progress(&mut request, 1, bytes.len() as u64, 1);
    commit(&mut request, 0, &[]);
    let (result, values) = serve(request, None);
    result.unwrap();
    let file = &values[0]["files"][0];
    assert_eq!(file["offset"], 512);
    assert_eq!(file["size"], body.len());
    assert_eq!(file["validation"]["metadata"], text);
    assert_eq!(file["sha1"].as_str().unwrap().len(), 40);
    assert_eq!(values[2]["done"], true);
}
#[test]
fn undeclared_file_bytes_are_not_consumed_and_partial_padding_keeps_source_prefix() {
    let directory = Directory::new();
    let (hash, body) = source(b"complete Source body");
    let bytes = entry(&hash, &body, b'0');
    let path = directory.archive(&bytes);
    let (_, values) = serve(start(&path, 0), None);
    assert_eq!(values.len(), 1);
    assert!(
        values[0]["files"]
            .as_array()
            .unwrap()
            .is_empty(),
    );
    assert_eq!(values[0]["fallback"], true);
    let store = Store::new(directory.0.join("objects"), None).unwrap();
    let mut request = start(&path, 0);
    progress(&mut request, 1, (512 + body.len()) as u64, 1);
    commit(&mut request, 0, &[0]);
    let (result, values) = serve(request, Some(&store));
    result.unwrap();
    assert_eq!(values[1]["persisted"], serde_json::json!([0]));
    assert_eq!(values[2]["error"], "Unexpected end of data");
    assert_eq!(
        std::fs::read(
            directory.0
                .join("objects")
                .join(&hash[..2])
                .join(&hash[2..])
        )
        .unwrap(),
        body,
    );
}
#[test]
fn invalid_progress_identity_extent_and_status_never_expose_undeclared_sources() {
    let directory = Directory::new();
    let (hash, body) = source(b"source");
    let path = directory.archive(&entry(&hash, &body, b'0'));
    let store = Store::new(directory.0.join("objects"), None).unwrap();
    for (id, extent, done) in [(2, 0, 0), (1, MAX_ARCHIVE + 1, 0), (1, 0, 2)] {
        let mut request = start(&path, 0);
        progress(&mut request, id, extent, done);
        let (_, values) = serve(request, Some(&store));
        assert_eq!(values.len(), 1);
        assert!(
            values[0]["error"]
                .as_str()
                .unwrap()
                .starts_with("invalid tar progress"),
        );
        assert!(!directory.0.join("objects").exists());
    }
    let mut request = start(&path, 0);
    progress(&mut request, 1, 512, 0);
    progress(&mut request, 1, 511, 0);
    let (_, values) = serve(request, Some(&store));
    assert_eq!(values[0]["error"], "invalid tar progress extent");
    assert!(!directory.0.join("objects").exists());
}
#[test]
fn progress_cannot_follow_eof_or_enter_a_fixed_archive_operation() {
    let directory = Directory::new();
    let path = directory.archive(&entry(".BIT.START", b"{}", b'0'));
    for progressive in [false, true] {
        let mut request = if progressive { start(&path, 0) } else { request(&path) };
        if progressive {
            progress(&mut request, 1, std::fs::metadata(&path).unwrap().len(), 1);
        }
        progress(&mut request, 1, 0, 0);
        commit(&mut request, 0, &[]);
        let (result, values) = serve(request, None);
        assert!(result.is_err());
        assert_eq!(values.len(), 1);
    }
}
#[test]
fn a_claimed_extent_beyond_written_bytes_reports_change_instead_of_waiting_or_reading_garbage() {
    let directory = Directory::new();
    let path = directory.archive(&[]);
    let mut request = start(&path, 0);
    progress(&mut request, 1, 512, 0);
    let (_, values) = serve(request, None);
    assert_eq!(values[0]["error"], "staged tar prefix changed before reading");
}
