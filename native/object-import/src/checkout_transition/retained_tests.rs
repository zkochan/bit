use super::{Fixture, State, plan};
use serde_json::json;
use std::{fs, path::PathBuf};

fn fixture() -> (Fixture, State, PathBuf) {
    let fixture = Fixture::new();
    let mut state = State::default();
    state.enable_retained_reads();
    let plan = plan::Plan {
        bodies: vec![plan::Body::new(vec![0, 255, 13, 10]), plan::Body::new(vec![])],
        target: vec![],
        target_indices: vec![],
        current: vec![],
        merge_rows: vec![],
        has_conflicts: false,
        statuses: vec![],
        other: None,
    };
    let output = state.plans
        .retain(plan, &json!({"packedBodies":true}), &fixture.0)
        .unwrap();
    let path = PathBuf::from(output["bodies"][0]["spoolPath"].as_str().unwrap());
    (fixture, state, path)
}
#[test]
#[cfg(unix)]
fn exact_owned_ranges_preserve_binary_bytes_order_empty_bodies_and_independence() {
    let (_fixture, state, path) = fixture();
    let mut first = state
        .read_retained(&path, &[(4, 0), (0, 4), (0, 4)])
        .unwrap();
    assert_eq!(first, [0, 255, 13, 10, 0, 255, 13, 10]);
    first.fill(42);
    assert_eq!(
        state
            .read_retained(&path, &[(0, 4)])
            .unwrap(),
        [0, 255, 13, 10],
    );
    assert!(
        state
            .read_retained(&path, &[(1, 3)])
            .is_none(),
    );
    assert!(
        state
            .read_retained(&path, &[(usize::MAX, 4)])
            .is_none(),
    );
    assert!(
        state
            .read_retained(&path, &vec![(0, 4); 4097])
            .is_none(),
    );
    assert!(
        state
            .read_retained(&path, &[])
            .is_none(),
    );
}
#[test]
fn changed_removed_or_replaced_spools_are_cache_misses() {
    let (_fixture, state, path) = fixture();
    fs::write(&path, [4, 3, 2, 1]).unwrap();
    assert!(
        state
            .read_retained(&path, &[(0, 4)])
            .is_none(),
    );
    fs::remove_file(&path).unwrap();
    assert!(
        state
            .read_retained(&path, &[(4, 0)])
            .is_none(),
    );
    fs::write(&path, [0, 255, 13, 10]).unwrap();
    assert!(
        state
            .read_retained(&path, &[(0, 4)])
            .is_none(),
    );
}
#[test]
#[cfg(unix)]
fn symlinks_and_finished_plans_cannot_supply_retained_bytes() {
    let (fixture, mut state, path) = fixture();
    let target = fixture.0.join("replacement");
    fs::rename(&path, &target).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(
        state
            .read_retained(&path, &[(0, 4)])
            .is_none(),
    );
    fs::remove_file(&path).unwrap();
    fs::rename(&target, &path).unwrap();
    state.plans.plans.clear();
    assert!(
        state
            .read_retained(&path, &[(0, 4)])
            .is_none(),
    );
}
