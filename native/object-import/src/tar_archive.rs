use crate::{
    tar_extensions::Extensions,
    tar_header::{self, Header, MAX_EXTENSION, invalid, unsupported},
    tar_progress::{Peer, Tail},
};
use std::{
    fs::File,
    io::{self, BufReader, Read},
    path::Path,
};

pub(crate) const MAX_ARCHIVE: u64 = 2 * 1024 * 1024 * 1024;
const MAX_OBJECTS: usize = 1_048_576;
pub(crate) struct Input {
    pub(crate) name: String,
    pub(crate) offset: u64,
    pub(crate) bytes: Vec<u8>,
}
pub(crate) struct Batch {
    pub(crate) inputs: Vec<Input>,
    pub(crate) terminal: Option<io::Error>,
    pub(crate) done: bool,
}
pub(crate) struct Archive<'a> {
    reader: BufReader<Box<dyn Read + 'a>>,
    extensions: Extensions,
    pending: Option<Header>,
    position: u64,
    count: usize,
    length: u64,
}
impl<'a> Archive<'a> {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let (file, length) = file(path)?;
        Ok(Self::new(Box::new(file), length))
    }
    pub(crate) fn progressive<Reader: Read + 'a>(
        path: &Path,
        peer: Peer<'a, Reader>,
    ) -> io::Result<Self> {
        let (file, _) = file(path)?;
        Ok(Self::new(Box::new(Tail::new(file, peer)), MAX_ARCHIVE))
    }
    fn new(reader: Box<dyn Read + 'a>, length: u64) -> Self {
        Self {
            reader: BufReader::new(reader),
            extensions: Extensions::default(),
            pending: None,
            position: 0,
            count: 0,
            length,
        }
    }
    pub(crate) fn batch(&mut self) -> Batch {
        let mut inputs = Vec::new();
        let result = self.fill(&mut inputs);
        let done = result.as_ref().map_or(true, |done| *done);
        Batch { inputs, terminal: result.err(), done }
    }
    fn fill(&mut self, inputs: &mut Vec<Input>) -> io::Result<bool> {
        let mut bytes = 0;
        while inputs.len() < 16 {
            let Some(header) = self.header()? else {
                return Ok(true);
            };
            if bytes + header.size > crate::protocol::MAX_BATCH_BYTES {
                self.pending = Some(header);
                break;
            }
            let offset = self.position;
            let data = self.data(header.size)?;
            let marker = matches!(header.name.as_str(), ".BIT.START" | ".BIT.END" | ".BIT.ERROR");
            bytes += data.len();
            inputs.push(Input { name: header.name, offset, bytes: data });
            self.count += 1;
            self.padding(header.size)?;
            if marker {
                break;
            }
        }
        Ok(false)
    }
    fn header(&mut self) -> io::Result<Option<Header>> {
        if let Some(header) = self.pending.take() {
            return Ok(Some(header));
        }
        while let Some(bytes) = self.block()? {
            let Some(mut header) = tar_header::decode(&bytes)? else {
                continue;
            };
            if self.extension(&header)? {
                continue;
            }
            self.extensions.apply(&mut header)?;
            if self.count >= MAX_OBJECTS {
                return Err(unsupported());
            }
            if header.kind == b'5' {
                header.size = 0;
            }
            return Ok(Some(header));
        }
        Ok(None)
    }
    fn extension(&mut self, header: &Header) -> io::Result<bool> {
        if !matches!(header.kind, b'g' | b'x' | b'L' | b'K' | b'N') {
            return Ok(false);
        }
        if header.size > MAX_EXTENSION {
            return Err(unsupported());
        }
        let bytes = self.body(header.size)?;
        self.extensions.accept(header.kind, &bytes)?;
        Ok(true)
    }
    fn block(&mut self) -> io::Result<Option<[u8; 512]>> {
        let mut bytes = [0; 512];
        if self.reader.read(&mut bytes[..1])? == 0 {
            return Ok(None);
        }
        exact(&mut self.reader, &mut bytes[1..])?;
        self.advance(512)?;
        Ok(Some(bytes))
    }
    fn data(&mut self, length: usize) -> io::Result<Vec<u8>> {
        if length as u64 > self.length.saturating_sub(self.position) {
            return Err(invalid("Unexpected end of data"));
        }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|_| unsupported())?;
        bytes.resize(length, 0);
        exact(&mut self.reader, &mut bytes)?;
        self.advance(length)?;
        Ok(bytes)
    }
    fn padding(&mut self, length: usize) -> io::Result<()> {
        let padding = (512 - length % 512) % 512;
        exact(&mut self.reader, &mut [0; 512][..padding])?;
        self.advance(padding)
    }
    fn body(&mut self, length: usize) -> io::Result<Vec<u8>> {
        let bytes = self.data(length)?;
        self.padding(length)?;
        Ok(bytes)
    }
    fn advance(&mut self, length: usize) -> io::Result<()> {
        self.position += length as u64;
        if self.position > MAX_ARCHIVE {
            return Err(unsupported());
        }
        Ok(())
    }
}
fn file(path: &Path) -> io::Result<(File, u64)> {
    if !path.is_absolute() {
        return Err(unsupported());
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_ARCHIVE {
        return Err(unsupported());
    }
    Ok((File::open(path)?, metadata.len()))
}
fn exact(reader: &mut impl Read, bytes: &mut [u8]) -> io::Result<()> {
    reader
        .read_exact(bytes)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                invalid("Unexpected end of data")
            } else {
                error
            }
        })
}
