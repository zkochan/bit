use crate::{protocol, store::Store, tar_archive::Archive};
use flate2::{Compression, write::ZlibEncoder};
use sha1::{Digest, Sha1};
use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .join(format!(
                "bit-tar-kernel-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed),
            ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn archive(&self, bytes: &[u8]) -> PathBuf {
        let path = self.0.join("archive.tar");
        fs::write(&path, bytes).unwrap();
        path
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _cleanup = fs::remove_dir_all(&self.0);
    }
}
fn entry(name: &str, body: &[u8], kind: u8) -> Vec<u8> {
    let mut header = [0; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    let size = format!("{:011o}", body.len());
    header[124..135].copy_from_slice(size.as_bytes());
    header[156] = kind;
    header[257..263].copy_from_slice(b"ustar\0");
    header[148..156].fill(32);
    let checksum: u32 = header
        .iter()
        .map(|byte| u32::from(*byte))
        .sum();
    let checksum = format!("{checksum:06o}\0 ");
    header[148..156].copy_from_slice(checksum.as_bytes());
    let mut bytes = header.to_vec();
    bytes.extend_from_slice(body);
    bytes.resize(bytes.len().next_multiple_of(512), 0);
    bytes
}
fn source(content: &[u8]) -> (String, Vec<u8>) {
    let hash = format!("{:x}", Sha1::digest(content));
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(format!("Source {hash} {}\0", content.len()).as_bytes())
        .unwrap();
    encoder.write_all(content).unwrap();
    (hash, encoder.finish().unwrap())
}
fn request(path: &std::path::Path) -> Vec<u8> {
    let name = path.to_str().unwrap().as_bytes();
    let mut bytes = b"BTI1".to_vec();
    for value in [1_u32, 1, name.len() as u32] {
        bytes.extend_from_slice(&value.to_be_bytes());
    }
    bytes.extend_from_slice(name);
    bytes
}
fn commit(bytes: &mut Vec<u8>, sequence: u32, selected: &[u32]) {
    bytes.extend_from_slice(b"BTC1");
    for value in [1_u32, sequence, selected.len() as u32] {
        bytes.extend_from_slice(&value.to_be_bytes());
    }
    for value in selected {
        bytes.extend_from_slice(&value.to_be_bytes());
    }
}
fn serve(bytes: Vec<u8>, store: Option<&Store>) -> (std::io::Result<()>, Vec<serde_json::Value>) {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .unwrap();
    let mut output = Vec::new();
    let result = protocol::serve_with_store(&mut Cursor::new(bytes), &mut output, &pool, store);
    let values = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    (result, values)
}
#[test]
fn no_source_is_written_without_a_complete_valid_selection() {
    let directory = Directory::new();
    let (hash, body) = source(b"source");
    let path = directory.archive(&entry(&hash, &body, b'0'));
    let root = directory.0.join("objects");
    let store = Store::new(root.clone(), None).unwrap();
    let (result, values) = serve(request(&path), Some(&store));
    assert!(result.is_err());
    assert_eq!(values.len(), 1);
    assert_eq!(values[0]["files"][0]["validation"]["status"], "source");
    assert!(!root.exists());
}
#[test]
fn only_selected_source_bytes_are_committed() {
    let directory = Directory::new();
    let (hash, body) = source(b"selected");
    let (other, other_body) = source(b"unselected");
    let bytes = [entry(&hash, &body, b'0'), entry(&other, &other_body, b'0')].concat();
    let path = directory.archive(&bytes);
    let root = directory.0.join("objects");
    let store = Store::new(root.clone(), None).unwrap();
    let mut request = request(&path);
    commit(&mut request, 0, &[0]);
    let (result, values) = serve(request, Some(&store));
    result.unwrap();
    assert_eq!(values[1]["persisted"], serde_json::json!([0]));
    assert_eq!(values.last().unwrap()["done"], true);
    assert_eq!(fs::read(root.join(&hash[..2]).join(&hash[2..])).unwrap(), body);
    assert!(
        !root
            .join(&other[..2])
            .join(&other[2..])
            .exists(),
    );
}
#[test]
fn duplicate_out_of_range_and_non_source_selections_write_nothing() {
    let directory = Directory::new();
    let (hash, body) = source(b"source");
    let path =
        directory.archive(&[entry(&hash, &body, b'0'), entry("unknown", b"data", b'0')].concat());
    let root = directory.0.join("objects");
    let store = Store::new(root.clone(), None).unwrap();
    for selected in [&[0, 0][..], &[2][..], &[1][..]] {
        let mut request = request(&path);
        commit(&mut request, 0, selected);
        assert!(serve(request, Some(&store)).0.is_err());
        assert!(!root.exists());
    }
}
#[test]
fn complete_body_is_reported_before_missing_padding_but_partial_body_is_not() {
    let directory = Directory::new();
    let bytes = entry("object", b"complete", b'0');
    for (length, count) in [(515, 0), (520, 1)] {
        let path = directory.archive(&bytes[..length]);
        let mut archive = Archive::open(&path).unwrap();
        let batch = archive.batch();
        assert_eq!(batch.inputs.len(), count);
        assert_eq!(batch.terminal.unwrap().to_string(), "Unexpected end of data");
    }
}
#[test]
fn batches_remain_bounded_and_sequences_cover_all_entries() {
    let directory = Directory::new();
    let bytes: Vec<_> = (0..33)
        .flat_map(|index| entry(&format!("entry{index}"), b"", b'0'))
        .collect();
    let path = directory.archive(&bytes);
    let mut request = request(&path);
    for sequence in 0..3 {
        commit(&mut request, sequence, &[]);
    }
    let (result, values) = serve(request, None);
    result.unwrap();
    assert_eq!(
        values[0]["files"]
            .as_array()
            .unwrap()
            .len(),
        16,
    );
    assert_eq!(
        values[2]["files"]
            .as_array()
            .unwrap()
            .len(),
        16,
    );
    assert_eq!(
        values[4]["files"]
            .as_array()
            .unwrap()
            .len(),
        1,
    );
    assert_eq!(values[6]["sequence"], 3);
    assert_eq!(values[6]["done"], true);
}
#[test]
fn markers_end_batches_before_later_objects() {
    let directory = Directory::new();
    let path = directory.archive(
        &[
            entry("before", b"", b'0'),
            entry(".BIT.ERROR", b"remote", b'0'),
            entry("after", b"", b'0'),
        ]
        .concat(),
    );
    let mut archive = Archive::open(&path).unwrap();
    let batch = archive.batch();
    assert_eq!(batch.inputs.len(), 2);
    assert!(!batch.done);
    assert_eq!(archive.batch().inputs[0].name, "after");
}
#[test]
fn regular_archive_and_extension_bounds_reject_before_body_allocation() {
    let directory = Directory::new();
    assert!(Archive::open(&directory.0).is_err());
    assert!(Archive::open(std::path::Path::new("relative.tar")).is_err());
    let bytes = entry("extension", &vec![0; 65537], b'x');
    let path = directory.archive(&bytes);
    let batch = Archive::open(&path).unwrap().batch();
    assert!(batch.inputs.is_empty());
    assert_eq!(batch.terminal.unwrap().kind(), std::io::ErrorKind::Unsupported);
}
#[test]
fn wrong_sequence_and_missing_store_reject_without_successful_acknowledgement() {
    let directory = Directory::new();
    let (hash, body) = source(b"source");
    let path = directory.archive(&entry(&hash, &body, b'0'));
    for sequence in [0, 7] {
        let mut request = request(&path);
        commit(&mut request, sequence, &[0]);
        let (result, values) = serve(request, None);
        assert!(result.is_err());
        assert_eq!(values.len(), 1);
    }
}
fn compressed(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
#[test]
fn metadata_flag_returns_lossless_text_and_preserves_legacy_default() {
    let directory = Directory::new();
    let hash = "a".repeat(40);
    let text = format!("Version {hash} 0\0{{\"unicode\":\"日本語 🚀\",\"invalid\":");
    let path = directory.archive(&entry(&hash, &compressed(text.as_bytes()), b'0'));
    for (flags, status) in [(1_u32, "legacy"), (2, "metadata"), (3, "metadata")] {
        let mut request = request(&path);
        request[8..12].copy_from_slice(&flags.to_be_bytes());
        commit(&mut request, 0, &[]);
        let (result, values) = serve(request, None);
        result.unwrap();
        let value = &values[0]["files"][0]["validation"];
        assert_eq!(value["status"], status);
        if flags & 2 != 0 {
            assert_eq!(value["metadata"], text);
            assert_eq!(value["inflatedBytes"], text.len());
            assert!(value["reason"].is_null());
        } else {
            assert!(value["metadata"].is_null());
        }
    }
}
#[test]
fn metadata_response_budget_preserves_order_and_downgrades_excess_entries() {
    let directory = Directory::new();
    let hash = "a".repeat(40);
    let mut text = format!("Version {hash} 0\0").into_bytes();
    text.resize(crate::metadata::MAX_BYTES, b'a');
    let bytes = entry(&hash, &compressed(&text), b'0').repeat(3);
    let path = directory.archive(&bytes);
    let mut request = request(&path);
    request[8..12].copy_from_slice(&2_u32.to_be_bytes());
    commit(&mut request, 0, &[]);
    let (result, values) = serve(request, None);
    result.unwrap();
    let files = values[0]["files"].as_array().unwrap();
    assert_eq!(files[0]["validation"]["status"], "metadata");
    assert_eq!(files[1]["validation"]["status"], "metadata");
    assert_eq!(files[2]["validation"]["status"], "legacy");
    assert_eq!(files[2]["validation"]["reason"], "metadata-response-limit");
    assert_eq!(files[2]["validation"]["inflatedBytes"], 0);
    assert!(files[2]["validation"]["metadata"].is_null());
}
#[test]
fn metadata_is_never_a_selectable_source_and_unknown_flags_reject() {
    let directory = Directory::new();
    let hash = "a".repeat(40);
    let text = format!("Version {hash} 2\0{{}}");
    let path = directory.archive(&entry(&hash, &compressed(text.as_bytes()), b'0'));
    let store = Store::new(directory.0.join("objects"), None).unwrap();
    for flags in [2_u32, 4] {
        let mut request = request(&path);
        request[8..12].copy_from_slice(&flags.to_be_bytes());
        commit(&mut request, 0, &[0]);
        assert!(serve(request, Some(&store)).0.is_err());
        assert!(!directory.0.join("objects").exists());
    }
}
