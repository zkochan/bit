use super::{
    super::main_file::{choose, resolve},
    fixture, source,
};
fn find(files: &[&str], main: Option<&str>, existing: Option<&str>) -> std::io::Result<String> {
    choose(
        "scope/bar/foo",
        "bar",
        &files
            .iter()
            .map(|file| (*file).into())
            .collect::<Vec<_>>(),
        main,
        existing,
    )
}
#[test]
fn existing_main_wins_without_explicit_override() {
    assert_eq!(find(&["new.js"], None, Some("old.js")).unwrap(), "old.js");
}
#[test]
fn explicit_override_wins() {
    assert_eq!(find(&["old.js", "new.js"], Some("new.js"), Some("old.js")).unwrap(), "new.js");
}
#[test]
fn explicit_missing_does_not_guess() {
    assert!(find(&["index.js"], Some("missing.js"), None).is_err());
}
#[test]
fn one_file_is_main() {
    assert_eq!(find(&["sole.txt"], None, None).unwrap(), "sole.txt");
}
#[test]
fn index_extension_precedence() {
    assert_eq!(find(&["index.ts", "index.js"], None, None).unwrap(), "index.js");
}
#[test]
fn directory_basename_is_fallback() {
    assert_eq!(find(&["other.txt", "bar.ts"], None, None).unwrap(), "bar.ts");
}
#[test]
fn angular_public_api_is_fallback() {
    assert_eq!(find(&["other.txt", "public_api.ts"], None, None).unwrap(), "public_api.ts");
}
#[test]
fn nearest_basename_matches() {
    assert_eq!(
        find(&["deep/nested/index.js", "near/index.js"], None, None).unwrap(),
        "near/index.js",
    );
}
#[test]
fn exact_path_wins_over_nested_basename() {
    assert_eq!(find(&["nested/index.js", "index.js"], Some("index.js"), None).unwrap(), "index.js");
}
#[test]
fn workspace_relative_main_maps_to_component() {
    assert_eq!(find(&["foo.js", "other.js"], Some("bar/foo.js"), None).unwrap(), "foo.js");
}
#[test]
fn no_strategy_reports_component_id() {
    assert!(
        find(&["first.txt", "second.txt"], None, None)
            .unwrap_err()
            .to_string()
            .contains("scope/bar/foo does not contain a main file"),
    );
}
#[test]
fn explicit_directory_is_rejected() {
    let root = fixture();
    source(&root, "bar/foo.js");
    assert!(
        resolve(&root, &root, Some("bar"), &["bar/foo.js".into()])
            .unwrap_err()
            .to_string()
            .contains("is a directory"),
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn explicit_main_dsl_uses_file_name() {
    let root = fixture();
    source(&root, "bar/main.js");
    assert_eq!(
        resolve(&root, &root, Some("bar/{FILE_NAME}.js"), &["bar/main.js".into()]).unwrap(),
        Some("bar/main.js".into()),
    );
    std::fs::remove_dir_all(root).unwrap();
}
