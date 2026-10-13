use super::plan::Body;
use std::{
    fs::OpenOptions,
    io::{self, BufWriter, Write},
    path::Path,
};
pub(super) fn assign(bodies: &mut [Body], directory: &Path, token: &str, first: usize) {
    let path = directory.join(format!("{token}-{first}.checkout-pack"));
    let mut offset = 0;
    for body in bodies {
        body.path.clone_from(&path);
        body.offset = Some(offset);
        offset += body.contents.len();
    }
}
fn write(bodies: &[Body]) -> io::Result<()> {
    let Some(first) = bodies.first() else {
        return Ok(());
    };
    if first.offset.is_none() {
        for body in bodies {
            body.spool()?;
        }
        return Ok(());
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&first.path)?;
    let mut output = BufWriter::new(file);
    for body in bodies {
        output.write_all(&body.contents)?;
    }
    output.flush()
}

pub(super) fn write_retained(bodies: &mut [Body], retain_reads: bool) -> io::Result<()> {
    write(bodies)?;
    if retain_reads {
        super::retained::capture(bodies);
    }
    Ok(())
}
