<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    hint?: string;
    children: Snippet;
  }
  let { label, hint, children }: Props = $props();
</script>

<label class="field">
  <span class="field-label label">{label}</span>
  {@render children()}
  {#if hint}<span class="field-hint">{hint}</span>{/if}
</label>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .field-label {
    color: var(--text-secondary);
  }
  .field-hint {
    font-size: 11.5px;
    color: var(--text-muted);
  }
</style>
