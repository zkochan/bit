use crate::{Request, limits, scan_with_metrics, transport};
use rayon::{ThreadPool, prelude::*};
use serde_json::{Value, json};

/// Keep the in-process response bounded before retaining another worker batch.
pub(crate) fn process(input: &str, pool: &ThreadPool) -> Result<Value, serde_json::Error> {
    let request: Request = serde_json::from_str(input)?;
    if request.version != 1 || request.files.len() > limits::BATCH_FILES {
        return Ok(transport::invalid_request("unsupported scanner request"));
    }
    let mut remaining: usize = 8 * 1024 * 1024;
    let mut files = Vec::with_capacity(request.files.len());
    for batch in request.files.chunks(pool.current_num_threads().min(8)) {
        let outcomes: Vec<_> = pool.install(|| {
            batch
                .par_iter()
                .map(|file| scan_with_metrics(file, !request.options.is_empty(), None))
                .collect()
        });
        for outcome in outcomes {
            let bytes = serde_json::to_vec(&outcome)?;
            let Some(next) = remaining.checked_sub(bytes.len()) else {
                return Ok(transport::invalid_request("embedded scanner output limit"));
            };
            remaining = next;
            files.push(serde_json::to_value(outcome)?);
        }
    }
    Ok(json!({"version":1,"id":request.id,"files":files}))
}
