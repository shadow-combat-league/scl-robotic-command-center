<script lang="ts">
  import { page } from "$app/stores";
  import Icon from "./Icon.svelte";

  const NAV = [
    { href: "/", label: "Home", icon: "home" },
    { href: "/robot", label: "Robot", icon: "robot" },
    { href: "/teleoperate", label: "Teleop", icon: "cube" },
    { href: "/headsets", label: "Headsets", icon: "headset" },
    { href: "/motions", label: "Motions", icon: "motion" },
    { href: "/settings", label: "Settings", icon: "settings" },
  ];

  function isActive(href: string, path: string): boolean {
    return href === "/" ? path === "/" : path.startsWith(href);
  }
</script>

<nav class="dock" aria-label="Primary">
  {#each NAV as item (item.href)}
    <a class="key" href={item.href} class:active={isActive(item.href, $page.url.pathname)}>
      <Icon name={item.icon} size={19} />
      <span class="lbl">{item.label}</span>
    </a>
  {/each}
</nav>

<style>
  .dock {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    gap: 4px;
    padding: 6px;
    background: color-mix(in srgb, var(--bg-elev-1) 90%, transparent);
    backdrop-filter: blur(10px);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2);
  }
  /* gold hairline along the top edge — the dock's signature */
  .dock::before {
    content: "";
    position: absolute;
    left: 16px;
    right: 16px;
    top: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--gold), transparent);
    opacity: 0.6;
  }

  .key {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    width: 68px;
    padding: 11px 6px 9px;
    color: var(--text-secondary);
    /* angular "stencil" key: beveled top corners */
    clip-path: polygon(7px 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 0 100%, 0 7px);
    transition:
      color var(--transition),
      background var(--transition);
  }
  .key .lbl {
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .key:hover {
    color: var(--text-primary);
    background: var(--bg-elev-2);
  }
  .key.active {
    color: var(--gold-bright);
    background: var(--gold-tint);
  }
  /* active notch at the top of the key */
  .key.active::after {
    content: "";
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 22px;
    height: 2px;
    background: var(--gold);
    box-shadow: 0 0 8px var(--gold-glow);
  }

  @media (max-width: 560px) {
    .dock {
      left: 8px;
      right: 8px;
      transform: none;
      justify-content: space-around;
    }
    .key {
      width: auto;
      flex: 1;
    }
  }
</style>
