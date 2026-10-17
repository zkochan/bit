use crate::{
    commands::move_paths::support::{self, aspect, bitmap, compare, json, successful},
    helper::{Helper, remote},
};
use std::fs;
fn workspace() -> Helper {
    let helper = support::workspace(1, false);
    super::lanes::install_delay(&helper);
    support::tag(&helper);
    remote::publish(&helper);
    helper
}
#[test]
fn exported_deprecating_rename_creates_new_identity_and_bidirectional_provenance() {
    let helper = workspace();
    successful(&helper, "rename comp1 comp2 --deprecate");
    let status = json(&helper, "status --json");
    assert_eq!(
        status["newComponents"]
            .as_array()
            .unwrap()
            .len(),
        1,
    );
    let deprecated = aspect(&helper, "comp1", "teambit.component/deprecation").unwrap();
    assert_eq!(deprecated["deprecate"], true);
    assert_eq!(deprecated["newId"]["name"], "comp2");
    assert_eq!(
        aspect(&helper, "comp2", "teambit.component/renaming").unwrap()["renamedFrom"]["name"],
        "comp1",
    );
    let ids: Vec<_> = json(&helper, "list --json")
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    for name in ["comp1", "comp2"] {
        assert!(ids.contains(&format!("{}/{name}", helper.scopes.remote)));
    }
}
#[test]
fn exported_rename_can_change_the_new_scope_and_delete_the_old_component() {
    for flag in ["--scope org.ui", "--delete"] {
        let helper = workspace();
        successful(&helper, &format!("rename comp1 comp2 {flag}"));
        assert_eq!(
            json(&helper, "status --json")["newComponents"]
                .as_array()
                .unwrap()
                .len(),
            1,
        );
        if flag == "--delete" {
            assert_eq!(
                aspect(&helper, "comp1", "teambit.component/remove").unwrap()["removed"],
                true,
            );
        } else {
            assert_eq!(support::show(&helper, "comp2", "id"), "org.ui/comp2");
        }
    }
}
#[test]
fn invalid_name_and_occupied_destination_do_not_leave_new_component_directories() {
    for command in ["rename comp1 my.comp", "rename comp1 comp2 --path src"] {
        let helper = workspace();
        helper.output_file("src/index.ts", "hello\n");
        let result = compare(&helper, command);
        assert!(!result.status.success());
        assert!(
            !helper.scopes.local_path
                .join(&helper.scopes.remote)
                .join("my.comp")
                .exists(),
        );
        assert_eq!(
            fs::read_to_string(helper.scopes.local_path.join("src/index.ts")).unwrap(),
            "hello\n",
        );
        assert!(bitmap(&helper).get("comp2").is_none());
    }
}
