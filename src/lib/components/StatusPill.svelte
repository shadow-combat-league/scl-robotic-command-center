<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    tone?: "green" | "gold" | "cyan" | "red" | "muted";
    dot?: boolean;
    pulse?: boolean;
    children: Snippet;
  }
  let { tone = "muted", dot = true, pulse = false, children }: Props = $props();
</script>

<span class="pill {tone}" class:pulse>
  {#if dot}<span class="dot"></span>{/if}
  {@render children()}
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: var(--r-sm);
    border: 1px solid;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }

  .green {
    color: var(--green);
    background: var(--green-tint);
    border-color: color-mix(in srgb, var(--green) 45%, transparent);
  }
  .gold {
    color: var(--gold);
    background: var(--gold-tint);
    border-color: color-mix(in srgb, var(--gold) 45%, transparent);
  }
  .cyan {
    color: var(--cyan);
    background: var(--cyan-tint);
    border-color: color-mix(in srgb, var(--cyan) 45%, transparent);
  }
  .red {
    color: var(--red-bright);
    background: var(--red-tint);
    border-color: color-mix(in srgb, var(--red) 50%, transparent);
  }
  .muted {
    color: var(--text-secondary);
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
  }

  .pulse .dot {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
    50% { box-shadow: 0 0 0 4px transparent; opacity: 0.55; }
  }
</style>
