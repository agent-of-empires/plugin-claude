#[cfg(test)]
mod tests {
    use aoe_plugin_api::PluginManifest;

    /// The pinned host accepts API 25, so the shipped manifest must validate cleanly there.
    #[test]
    fn manifest_validates_against_pinned_host() {
        let manifest: PluginManifest = toml::from_str(include_str!("../../../aoe-plugin.toml"))
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
