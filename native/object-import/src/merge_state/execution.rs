use super::{Request, State, apply};
use serde_json::Value;
use std::io;
pub(super) fn run(
    request: Request,
    state: &mut State,
    bytes: &[u8],
    pool: &rayon::ThreadPool,
) -> io::Result<Value> {
    if matches!(
        &request,
        Request::MergePrepare(_) | Request::MergeApply(_) | Request::CheckoutPrepare(_),
    ) {
        pool.install(|| apply(request, state, bytes))
    } else {
        apply(request, state, bytes)
    }
}

pub(crate) fn is_bounded_metadata(bytes: &[u8]) -> bool {
    matches!(
        serde_json::from_slice::<Request>(bytes),
        Ok(Request::MergeTransactionBegin(_)
            | Request::MergeTransactionReceipt(_)
            | Request::MergeStatusBegin(_)
            | Request::MergeStatusReceipt(_)
            | Request::MergeApplyDecision(_)
            | Request::MergeLaneBucketDecision(_)),
    )
}
