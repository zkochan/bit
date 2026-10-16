use super::{matching, unique};
use crate::workspace::engine::command::scratch::Directory;
use std::fs;

#[test]
fn short_refs_include_all_object_names_and_deduplicate_retained_objects() {
    let root = Directory::create().unwrap();
    fs::create_dir(root.0.join("ab")).unwrap();
    let first = format!("abc{}", "0".repeat(37));
    let second = format!("abc{}", "1".repeat(37));
    fs::write(root.0.join("ab").join(&first[2..]), b"Source bytes").unwrap();
    fs::write(root.0.join("ab/not-an-object"), b"ignored").unwrap();
    let refs = matching(&root.0, "abc", [first.clone(), second].into_iter()).unwrap();
    assert_eq!(refs.len(), 2);
    assert_eq!(
        unique("abc", &refs).unwrap_err().to_string(),
        "found 2 objects with the same short hash abc, please use longer hash",
    );
    let refs = matching(&root.0, "abc0", std::iter::empty()).unwrap();
    assert_eq!(unique("abc0", &refs).unwrap(), first);
    assert_eq!(
        unique("ddd", &[]).unwrap_err().to_string(),
        "failed finding an object with the short hash ddd",
    );
}
