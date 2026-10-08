use std::{
    fs,
    io::Cursor,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use rayon::ThreadPoolBuilder;

use super::serve;
use crate::store::Store;

static COUNTER: AtomicU64 = AtomicU64::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .join(format!(
                "bit-read-budget-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed),
            ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _cleanup = fs::remove_dir_all(&self.0);
    }
}
fn request(id: u32, count: u32) -> Cursor<Vec<u8>> {
    let mut bytes = id.to_be_bytes().to_vec();
    bytes.extend_from_slice(&count.to_be_bytes());
    for _ in 0..count {
        bytes.extend_from_slice(&[7; 20]);
    }
    Cursor::new(bytes)
}

#[test]
fn checked_read_budget_is_inclusive_and_oversize_batches_transfer_nothing() {
    let directory = Directory::new();
    let store = Store::new(directory.0.clone(), None).unwrap();
    let file = store.object_path(&[7; 20]);
    fs::create_dir(file.parent().unwrap()).unwrap();
    let pool = ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .unwrap();
    for (size, count, accepted) in
        [(256 * 1024, 16, true), (256 * 1024, 17, false), (256 * 1024 + 1, 1, false), (0, 1, true)]
    {
        fs::write(&file, vec![13; size]).unwrap();
        let mut output = Vec::new();
        serve(&mut request(1, count), &mut output, &pool, &store, *b"BRC1").unwrap();
        if accepted {
            assert_eq!(&output[..4], b"BRD1");
        } else {
            assert!(output.is_empty());
        }
    }
}

#[test]
fn checked_reads_reject_invalid_identity_count_and_truncated_hashes_before_output() {
    let directory = Directory::new();
    let store = Store::new(directory.0.clone(), None).unwrap();
    let pool = ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap();
    for mut input in [request(2, 1), request(1, 0), request(1, 4097), Cursor::new(vec![0; 9])] {
        let mut output = Vec::new();
        assert!(serve(&mut input, &mut output, &pool, &store, *b"BRC1").is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn header_times_match_node_arithmetic_and_reject_windows_wrapping_range() {
    use super::modified_milliseconds;
    use std::time::{Duration, UNIX_EPOCH};
    assert_eq!(modified_milliseconds(UNIX_EPOCH), Some(0.0));
    assert_eq!(modified_milliseconds(UNIX_EPOCH - Duration::from_nanos(1)), None);
    for (nanos, expected) in [
        (0, 1_700_000_000_000.0),
        (100, 1_700_000_000_000.0),
        (123_456_700, 1_700_000_000_123.456_8),
        (999_999_900, 1_700_000_001_000.0),
    ] {
        let timestamp = UNIX_EPOCH + Duration::new(1_700_000_000, nanos);
        assert_eq!(modified_milliseconds(timestamp), Some(expected));
    }
    let beyond = u64::from(u32::MAX) + 1;
    let timestamp = UNIX_EPOCH + Duration::from_secs(beyond);
    let expected = if cfg!(windows) { None } else { Some(beyond as f64 * 1000.0) };
    assert_eq!(modified_milliseconds(timestamp), expected);
}
