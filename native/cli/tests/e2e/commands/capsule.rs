use crate::{
    helper::{Helper, parse},
    known_failure::KnownResult,
};
use serde_json::json;
use std::{ffi::OsStr, fs};

#[test]
fn capsule_list_with_stats_matches_node() -> KnownResult<()> {
    let helper = Helper::new();
    helper.re_init_workspace();
    let root = helper.scopes.e2e_dir.join("capsule-stats-cache");
    let globals = helper.own_global_config("capsules_root_base_dir", root.to_str().unwrap());
    let config_path = globals.join("config/config.json");
    let mut config = parse(&fs::read_to_string(&config_path).unwrap());
    config["capsules_max_age_days"] = json!(0);
    fs::write(&config_path, config.to_string()).unwrap();

    let orphan = root.join("orphan");
    let aspects = root.join("aspects");
    let unmarked = root.join("unmarked");
    fs::create_dir_all(&orphan).unwrap();
    fs::create_dir_all(aspects.join("aspect@1.0.0")).unwrap();
    fs::create_dir_all(&unmarked).unwrap();
    fs::write(unmarked.join("payload"), vec![b'x'; 1_280]).unwrap();
    fs::write(orphan.join("file.txt"), "hello").unwrap();
    fs::write(
        orphan.join(".bit-capsule-origin.json"),
        json!({"originPath": root.join("missing"), "createdAt": "2020-01-01", "kind": "workspace"})
            .to_string(),
    )
    .unwrap();
    fs::write(aspects.join(".bit-capsule-origin.json"),
        json!({"originPath": helper.scopes.local_path, "createdAt": "2020-01-01", "kind": "scope-aspects-root"}).to_string()).unwrap();

    for command in ["capsule list --with-stats", "capsule list --with-stats --json"] {
        let node = Helper::cmd_in_with(
            &helper.scopes.local_path,
            command,
            &[("BIT_GLOBALS_DIR", globals.as_os_str()), ("BIT_NATIVE", OsStr::new("off"))],
        );
        let native = Helper::cmd_in_with(
            &helper.scopes.local_path,
            command,
            &[("BIT_GLOBALS_DIR", globals.as_os_str())],
        );
        assert!(node.status.success(), "{command}: {node:?}");
        assert!(native.status.success() && native.native, "{command}: {native:?}");
        if command.ends_with("--json") {
            assert_eq!(parse(&native.stdout), parse(&node.stdout), "{command}");
        } else {
            assert_eq!(native.stdout, node.stdout, "{command}");
        }
    }
    Ok(())
}
