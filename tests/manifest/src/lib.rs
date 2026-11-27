#[cfg(test)]
mod tests {
    use aoe_plugin_api::PluginManifest;
    use std::collections::BTreeSet;

    const MANIFEST: &str = include_str!("../../../aoe-plugin.toml");
    const PIN: &str = include_str!("../../aoe-pin.toml");
    const CARGO_TOML: &str = include_str!("../Cargo.toml");
    const CASES: &str = include_str!("../../parity/cases.toml");

    fn pin_value(key: &str) -> String {
        let table: toml::Table = PIN.parse().expect("aoe-pin.toml must parse");
        table[key]
            .as_str()
            .unwrap_or_else(|| panic!("aoe-pin.toml needs a string `{key}`"))
            .to_string()
    }

    /// Compare the manifest's declared agent tools with the expected list.
    fn assert_declarations(manifest: &PluginManifest, expected_tools: &[&str]) {
        let mut actual: Vec<&str> = manifest
            .agent_integrations
            .iter()
            .map(|integration| integration.tool.as_str())
            .collect();
        let mut expected = expected_tools.to_vec();
        actual.sort_unstable();
        expected.sort_unstable();
        assert_eq!(actual, expected, "agent_integrations tools differ");
    }

    /// Cargo.toml and tests/aoe-pin.toml must name the same core commit.
    #[test]
    fn cargo_rev_matches_pin() {
        let rev = pin_value("rev");
        let cargo: toml::Table = CARGO_TOML.parse().expect("Cargo.toml must parse");
        let cargo_rev = cargo["dependencies"]["aoe-plugin-api"]["rev"]
            .as_str()
            .expect("Cargo.toml aoe-plugin-api needs a string `rev`");
        assert_eq!(
            cargo_rev, rev,
            "Cargo.toml aoe-plugin-api rev must equal the rev in tests/aoe-pin.toml"
        );
    }

    /// The manifest's `aoe_version` range must admit the pinned core version.
    #[test]
    fn aoe_version_admits_pinned_core() {
        let manifest: PluginManifest = toml::from_str(MANIFEST).expect("manifest must parse");
        let version = pin_value("version");
        if let Err(error) = manifest.host_compat(&version) {
            panic!("aoe_version must admit pinned core {version}: {error}");
        }
    }

    #[test]
    fn shipped_manifest_declares_no_agent_tools() {
        let manifest: PluginManifest = toml::from_str(MANIFEST).expect("manifest must parse");
        assert_declarations(&manifest, &[]);
    }

    /// A manifest that lacks an expected tool must fail the declaration check.
    #[test]
    #[should_panic(expected = "agent_integrations tools differ")]
    fn missing_declaration_is_detected() {
        let manifest: PluginManifest = toml::from_str(
            r#"
id = "agent-of-empires.synthetic"
name = "Synthetic"
version = "0.1.0"
api_version = 25
capabilities = ["session.integration"]

[[agent_integrations]]
tool = "present"
command = "present"
provider_versions = [">=1.0.0"]
"#,
        )
        .expect("synthetic manifest must parse");
        manifest
            .validate()
            .expect("synthetic manifest must validate");
        assert_declarations(&manifest, &["present"]);
        assert_declarations(&manifest, &["present", "absent"]);
    }

    #[test]
    fn parity_cases_are_well_formed() {
        let table: toml::Table = CASES.parse().expect("cases.toml must parse");
        let cases = table["case"]
            .as_array()
            .expect("cases.toml needs [[case]] rows");
        let ids: Vec<&str> = cases
            .iter()
            .map(|case| case["id"].as_str().expect("case id must be a string"))
            .collect();
        let expected: BTreeSet<String> = (2..=18).chain(21..=53).map(|n| format!("T{n}")).collect();
        let actual: BTreeSet<String> = ids.iter().map(|id| id.to_string()).collect();
        assert_eq!(ids.len(), 50, "expected 50 rows");
        assert_eq!(
            actual, expected,
            "case ids must be exactly T2..T18 and T21..T53"
        );
        for case in cases {
            let id = case["id"].as_str().unwrap();
            let status = case["status"]
                .as_str()
                .expect("case status must be a string");
            assert!(
                ["pending", "active"].contains(&status),
                "{id}: bad status {status}"
            );
            let owner = case["owner"]
                .as_integer()
                .expect("case owner must be an integer");
            assert!([2, 3, 4].contains(&owner), "{id}: bad owner {owner}");
        }
    }

    /// The pinned host accepts API 25, so the shipped manifest must validate cleanly there.
    #[test]
    fn manifest_validates_against_pinned_host() {
        let manifest: PluginManifest = toml::from_str(MANIFEST)
            .expect("plugin manifest must parse against the pinned AoE schema");
        if let Err(error) = manifest.validate() {
            panic!("the manifest must validate against the released API 25 host: {error:?}");
        }
        assert_eq!(manifest.api_version, 25);
        assert_eq!(manifest.id.to_string(), "agent-of-empires.claude");
        assert!(manifest.commands.is_empty());
        assert!(manifest.settings.is_empty());
        assert!(manifest.ui.is_empty());
        assert!(manifest
            .capabilities
            .iter()
            .any(|cap| cap.as_str() == "runtime.worker"));
    }
}
