<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    eyebrow?: string;
    title: string;
    subtitle?: string;
    actions?: Snippet;
  }
  let { eyebrow, title, subtitle, actions }: Props = $props();
</script>

<header class="page-head">
  <div class="head-text">
    {#if eyebrow}<div class="eyebrow label">{eyebrow}</div>{/if}
    <h1>{title}</h1>
    {#if subtitle}<p class="sub">{subtitle}</p>{/if}
  </div>
  {#if actions}<div class="head-actions">{@render actions()}</div>{/if}
</header>

<style>
  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 22px;
  }
  .eyebrow {
    color: var(--gold);
    margin-bottom: 7px;
  }
  h1 {
    font-size: 25px;
    color: var(--text-primary);
  }
  .sub {
    margin-top: 6px;
    color: var(--text-secondary);
    font-size: 13.5px;
    max-width: 60ch;
  }
  .head-actions {
    display: inline-flex;
    gap: 10px;
    flex: none;
  }
</style>
