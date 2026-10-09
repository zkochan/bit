use std::io;

pub(crate) const MAX_BODY: usize = 128 * 1024 * 1024;
pub(crate) const MAX_EXTENSION: usize = 64 * 1024;
pub(crate) struct Header {
    pub(crate) name: String,
    pub(crate) size: usize,
    pub(crate) kind: u8,
}
pub(crate) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
pub(crate) fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "unsupported or oversized tar entry")
}
pub(crate) fn text(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}
pub(crate) fn number(bytes: &[u8], radix: u32) -> io::Result<usize> {
    let value = text(bytes);
    let value = value.trim();
    if value.is_empty() {
        return Ok(0);
    }
    usize::from_str_radix(value, radix).map_err(|_| unsupported())
}
pub(crate) fn decode(bytes: &[u8; 512]) -> io::Result<Option<Header>> {
    let sum: usize = bytes
        .iter()
        .enumerate()
        .map(|(index, byte)| if (148..156).contains(&index) { 32 } else { usize::from(*byte) })
        .sum();
    if sum == 256 {
        return Ok(None);
    }
    if sum != number(&bytes[148..156], 8)? {
        return Err(invalid(
            "Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?",
        ));
    }
    let name = name(bytes)?;
    let size = number(&bytes[124..136], 8)?;
    if size > MAX_BODY {
        return Err(unsupported());
    }
    Ok(Some(Header { name, size, kind: bytes[156] }))
}
fn name(bytes: &[u8; 512]) -> io::Result<String> {
    let name = text(&bytes[..100]);
    if &bytes[257..263] == b"ustar\0" {
        let prefix = text(&bytes[345..500]);
        return Ok(if prefix.is_empty() { name } else { format!("{prefix}/{name}") });
    }
    if &bytes[257..265] == b"ustar  \0" {
        return Ok(name);
    }
    Err(invalid("Invalid tar header: unknown format."))
}
