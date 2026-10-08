mod protocol;
mod validate;

use std::{env, io, process::ExitCode};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let threads = if args.is_empty() {
        std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get).min(4)
    } else if args.len() == 2 && args[0] == "--threads" {
        args[1].parse::<usize>()?
    } else {
        return Err("usage: bit-object-import [--threads 1..8]".into());
    };
    if !(1..=8).contains(&threads) {
        return Err("thread count must be between 1 and 8".into());
    }
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build()?;
    protocol::serve(&mut io::stdin().lock(), &mut io::stdout().lock(), &pool)?;
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("bit-object-import: {error}");
            ExitCode::FAILURE
        }
    }
}
