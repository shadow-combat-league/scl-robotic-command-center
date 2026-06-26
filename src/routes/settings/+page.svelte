<script lang="ts">
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Placeholder from "$lib/components/Placeholder.svelte";
</script>

<PageHeader
  eyebrow="Settings"
  title="Settings"
  subtitle="Manage saved robot profiles, network defaults, and device configuration for the command center."
/>

<Placeholder
  icon="settings"
  note="Device and configuration management. Scoped after the operator-facing flows are complete."
  planned={[
    "Edit & delete saved robot profiles",
    "Per-type network defaults (ethernet IP, SSH user)",
    "Firmware version tracking & update prompts",
    "Local database export / import",
  ]}
/>
