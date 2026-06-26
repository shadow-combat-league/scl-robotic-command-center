<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    icon?: string;
    href?: string;
    disabled?: boolean;
    type?: "button" | "submit";
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
  }

  let {
    variant = "secondary",
    size = "md",
    icon,
    href,
    disabled = false,
    type = "button",
    onclick,
    children,
  }: Props = $props();
</script>

{#if href}
  <a class="btn {variant} {size}" {href} class:disabled {onclick}>
    {#if icon}<Icon name={icon} size={size === "sm" ? 14 : 16} />{/if}
    {@render children()}
  </a>
{:else}
  <button class="btn {variant} {size}" {type} {disabled} {onclick}>
    {#if icon}<Icon name={icon} size={size === "sm" ? 14 : 16} />{/if}
    {@render children()}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    border: 1px solid transparent;
    border-radius: var(--r-md);
    transition: all var(--transition);
    color: var(--text-primary);
  }
  .btn.md {
    font-size: 12px;
    padding: 9px 16px;
  }
  .btn.sm {
    font-size: 11px;
    padding: 6px 11px;
  }

  .btn.primary {
    background: var(--gold);
    color: #1a1405;
    border-color: var(--gold);
  }
  .btn.primary:hover {
    background: var(--gold-bright);
    box-shadow: 0 0 18px var(--gold-glow);
  }

  .btn.secondary {
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
    color: var(--text-primary);
  }
  .btn.secondary:hover {
    border-color: var(--gold);
    color: var(--gold-bright);
    background: var(--bg-elev-3);
  }

  .btn.ghost {
    background: transparent;
    color: var(--text-secondary);
  }
  .btn.ghost:hover {
    color: var(--gold-bright);
    background: var(--gold-tint);
  }

  .btn.danger {
    background: var(--red-tint);
    border-color: var(--red);
    color: var(--red-bright);
  }
  .btn.danger:hover {
    background: var(--red);
    color: #fff;
    box-shadow: 0 0 18px var(--red-glow);
  }

  .btn:disabled,
  .btn.disabled {
    opacity: 0.45;
    pointer-events: none;
  }
</style>
