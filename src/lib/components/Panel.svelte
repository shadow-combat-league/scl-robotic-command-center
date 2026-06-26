<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    title?: string;
    icon?: string;
    /** Optional content rendered on the right of the header. */
    actions?: Snippet;
    /** Whole-panel padding off (e.g. for lists/tables). */
    flush?: boolean;
    children: Snippet;
  }
  let { title, icon, actions, flush = false, children }: Props = $props();
</script>

<section class="panel">
  {#if title}
    <header class="panel-head">
      <span class="panel-title">
        {#if icon}<Icon name={icon} size={15} />{/if}
        {title}
      </span>
      {#if actions}<div class="panel-actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="panel-body" class:flush>
    {@render children()}
  </div>
</section>

<style>
  .panel {
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 16px;
    border-bottom: 1px solid var(--border-soft);
  }
  .panel-title {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .panel-title :global(svg) {
    color: var(--gold);
  }
  .panel-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .panel-body {
    padding: 16px;
  }
  .panel-body.flush {
    padding: 0;
  }
</style>
