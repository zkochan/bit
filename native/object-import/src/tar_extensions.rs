use crate::tar_header::{Header, MAX_EXTENSION, number, text, unsupported};
use std::{collections::HashMap, io};

#[derive(Default)]
pub(crate) struct Extensions {
    global: HashMap<String, String>,
    local: Option<HashMap<String, String>>,
    long_name: Option<String>,
}
impl Extensions {
    pub(crate) fn accept(&mut self, kind: u8, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > MAX_EXTENSION {
            return Err(unsupported());
        }
        match kind {
            b'g' => self.global = pax(bytes)?,
            b'x' => {
                let mut local = self.global.clone();
                local.extend(pax(bytes)?);
                self.local = Some(local);
            }
            b'L' | b'N' => self.long_name = Some(text(bytes)),
            b'K' => {}
            _ => return Err(unsupported()),
        }
        Ok(())
    }
    pub(crate) fn apply(&mut self, header: &mut Header) -> io::Result<()> {
        if let Some(name) = self.long_name
            .take()
            .filter(|name| !name.is_empty())
        {
            header.name = name;
        }
        if let Some(local) = self.local.take() {
            if let Some(path) = local
                .get("path")
                .filter(|value| !value.is_empty())
            {
                header.name.clone_from(path);
            }
            if let Some(size) = local
                .get("size")
                .filter(|value| !value.is_empty())
            {
                header.size = number(size.as_bytes(), 10)?;
            }
        }
        if header.name.len() > MAX_EXTENSION || header.size > crate::tar_header::MAX_BODY {
            return Err(unsupported());
        }
        Ok(())
    }
}
fn pax(mut bytes: &[u8]) -> io::Result<HashMap<String, String>> {
    let mut fields = HashMap::new();
    while !bytes.is_empty() {
        let Some(space) = bytes
            .iter()
            .position(|byte| *byte == b' ')
        else {
            break;
        };
        let length = number(&bytes[..space], 10)?;
        if length == 0 {
            break;
        }
        if length <= space + 1 || length > bytes.len() {
            return Err(unsupported());
        }
        let field = String::from_utf8_lossy(&bytes[space + 1..length - 1]);
        let Some((key, value)) = field.split_once('=') else {
            break;
        };
        fields.insert(key.into(), value.into());
        bytes = &bytes[length..];
    }
    Ok(fields)
}
