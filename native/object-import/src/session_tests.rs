use crate::WorkspaceSession;
use serde_json::json;

fn frame(body: &[u8]) -> Vec<u8> {
    let mut bytes = b"BMT1".to_vec();
    bytes.extend_from_slice(&1_u32.to_be_bytes());
    bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}

#[test]
fn only_bounded_memory_only_requests_are_inline() {
    for kind in [
        "mergeTransactionBegin",
        "mergeTransactionReceipt",
        "mergeStatusBegin",
        "mergeStatusReceipt",
        "mergeApplyDecision",
        "mergeLaneBucketDecision",
    ] {
        assert!(WorkspaceSession::is_bounded_metadata(&frame(
            &serde_json::to_vec(&json!({"kind":kind})).expect("metadata"),
        )));
    }
    for kind in [
        "mergePrepare",
        "mergeMaterialize",
        "mergeTransactionFinish",
        "inspectionFiles",
        "historyQueryBegin",
        "mergeResultsSelect",
        "checkoutPrepare",
        "unknown",
    ] {
        assert!(!WorkspaceSession::is_bounded_metadata(&frame(
            &serde_json::to_vec(&json!({"kind":kind})).expect("metadata"),
        )));
    }
}

#[test]
fn malformed_or_large_frames_cannot_enter_inline_dispatch() {
    let good = frame(br#"{"kind":"mergeTransactionBegin"}"#);
    for length in 0..good.len() {
        assert!(!WorkspaceSession::is_bounded_metadata(&good[..length]));
    }
    let mut extra = good.clone();
    extra.push(0);
    assert!(!WorkspaceSession::is_bounded_metadata(&extra));
    let mut other = good;
    other[..4].copy_from_slice(b"BWS1");
    assert!(!WorkspaceSession::is_bounded_metadata(&other));
    assert!(!WorkspaceSession::is_bounded_metadata(&frame(b"invalid")));
    assert!(!WorkspaceSession::is_bounded_metadata(&frame(
        &serde_json::to_vec(&json!({"kind":"mergeStatusReceipt","value":"x".repeat(16384)}))
            .expect("metadata"),
    )));
    assert!(!WorkspaceSession::is_bounded_metadata(&frame(
        br#"{"kind":"mergeTransactionBegin","kind":"mergeMaterialize"}"#,
    )));
}
