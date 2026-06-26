<script lang="ts">
  import Icon from "./Icon.svelte";

  interface Props {
    icon: string;
    note: string;
    planned: string[];
  }
  let { icon, note, planned }: Props = $props();
</script>

<div class="placeholder">
  <span class="ph-icon"><Icon name={icon} size={28} /></span>
  <p class="ph-note">{note}</p>
  <div class="ph-tag label">Planned for this screen</div>
  <ul class="ph-list">
    {#each planned as item (item)}
      <li><Icon name="chevronRight" size={14} />{item}</li>
    {/each}
  </ul>
</div>

<style>
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;
    padding: 48px 24px;
    background: var(--bg-elev-1);
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-lg);
  }
  .ph-icon {
    display: grid;
    place-items: center;
    width: 60px;
    height: 60px;
    border-radius: var(--r-lg);
    background: var(--gold-tint);
    color: var(--gold);
    border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent);
  }
  .ph-note {
    color: var(--text-secondary);
    font-size: 14px;
    max-width: 52ch;
  }
  .ph-tag {
    margin-top: 8px;
    color: var(--text-faint);
  }
  .ph-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
  }
  .ph-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .ph-list :global(svg) {
    color: var(--gold);
    flex: none;
  }
</style>
