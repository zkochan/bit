use crate::{protocol, tar_archive::MAX_ARCHIVE, tar_header::invalid};
use std::{
    cell::RefCell,
    fs::File,
    io::{self, Read},
    rc::Rc,
};

struct Shared<'a, Reader> {
    reader: &'a mut Reader,
    id: u32,
    bytes: u64,
    done: bool,
    progressive: bool,
}
pub(crate) struct Peer<'a, Reader>(Rc<RefCell<Shared<'a, Reader>>>);
impl<Reader> Clone for Peer<'_, Reader> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}
impl<'a, Reader: Read> Peer<'a, Reader> {
    pub(crate) fn new(reader: &'a mut Reader, id: u32, progressive: bool) -> Self {
        Self(Rc::new(RefCell::new(Shared { reader, id, bytes: 0, done: false, progressive })))
    }
    pub(crate) fn commit_magic(&mut self) -> io::Result<[u8; 4]> {
        loop {
            let mut magic = [0; 4];
            self.read_exact(&mut magic)?;
            if magic != *b"BTP1" {
                return Ok(magic);
            }
            self.progress()?;
        }
    }
    fn progress(&mut self) -> io::Result<()> {
        let id = protocol::word(self)?;
        let bytes = (u64::from(protocol::word(self)?) << 32) | u64::from(protocol::word(self)?);
        let done = protocol::word(self)?;
        let mut shared = self.0.borrow_mut();
        if !shared.progressive || shared.done || id != shared.id {
            return Err(invalid("invalid tar progress identity"));
        }
        if bytes < shared.bytes || bytes > MAX_ARCHIVE || done > 1 {
            return Err(invalid("invalid tar progress extent"));
        }
        shared.bytes = bytes;
        shared.done = done == 1;
        Ok(())
    }
    fn wait(&mut self) -> io::Result<()> {
        let mut magic = [0; 4];
        self.read_exact(&mut magic)?;
        if magic != *b"BTP1" {
            return Err(invalid("expected tar progress before reading more bytes"));
        }
        self.progress()
    }
}
impl<Reader: Read> Read for Peer<'_, Reader> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.borrow_mut().reader.read(bytes)
    }
}
pub(crate) struct Tail<'a, Reader> {
    file: File,
    peer: Peer<'a, Reader>,
    position: u64,
}
impl<'a, Reader: Read> Tail<'a, Reader> {
    pub(crate) fn new(file: File, peer: Peer<'a, Reader>) -> Self {
        Self { file, peer, position: 0 }
    }
}
impl<Reader: Read> Read for Tail<'_, Reader> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        loop {
            let (available, done) = {
                let shared = self.peer.0.borrow();
                (shared.bytes - self.position, shared.done)
            };
            if available != 0 {
                let length = bytes.len().min(available as usize);
                let count = self.file.read(&mut bytes[..length])?;
                if count == 0 {
                    return Err(invalid("staged tar prefix changed before reading"));
                }
                self.position += count as u64;
                return Ok(count);
            }
            if done {
                return Ok(0);
            }
            self.peer.wait()?;
        }
    }
}
