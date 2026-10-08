use std::io::Cursor;

use super::request;

fn frame(count: u32, prefixes: &[u8]) -> Cursor<Vec<u8>> {
    let mut bytes = 7_u32.to_be_bytes().to_vec();
    bytes.extend_from_slice(&count.to_be_bytes());
    bytes.extend_from_slice(prefixes);
    Cursor::new(bytes)
}

#[test]
fn directory_requests_require_bounded_unique_descending_lowercase_prefixes() {
    assert_eq!(
        request(&mut frame(3, b"ff7f00")).unwrap(),
        (7, vec!["ff".into(), "7f".into(), "00".into()]),
    );
    for (count, prefixes) in [
        (0, &b""[..]),
        (257, &b""[..]),
        (2, &b"0000"[..]),
        (2, &b"007f"[..]),
        (1, &b"FF"[..]),
        (1, &b"zz"[..]),
    ] {
        assert!(request(&mut frame(count, prefixes)).is_err());
    }
}

#[test]
fn truncated_directory_requests_never_return_partial_prefixes() {
    assert!(request(&mut frame(2, b"ff0")).is_err());
    assert!(request(&mut Cursor::new(vec![0; 7])).is_err());
}
