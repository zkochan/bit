use super::{diagnostic, display};
use std::path::Path;

#[test]
fn diagnostics_use_platform_paths_without_changing_stored_paths() {
    let stored = "bar/nested/foo.js";
    let expected = ["bar", "nested", "foo.js"].join(std::path::MAIN_SEPARATOR_STR);
    assert_eq!(diagnostic(stored), expected);
    assert_eq!(display(Path::new("workspace"), &Path::new("workspace").join(stored)), expected);
    assert_eq!(stored, "bar/nested/foo.js");
}
