<script lang="ts">
  import { page } from "$app/stores";
  import Icon from "./Icon.svelte";
  import { robot } from "$lib/services/robot.svelte";

  const NAV = [
    { href: "/", label: "Home", icon: "home" },
    { href: "/robot", label: "Robot", icon: "robot" },
    { href: "/teleoperate", label: "Teleoperate", icon: "cube" },
    { href: "/motions", label: "Motions", icon: "motion" },
    { href: "/settings", label: "Settings", icon: "settings" },
  ];

  function isActive(href: string, path: string): boolean {
    return href === "/" ? path === "/" : path.startsWith(href);
  }
</script>

<nav class="sidebar">
  <ul class="nav">
    {#each NAV as item (item.href)}
      <li>
        <a class="nav-item" href={item.href} class:active={isActive(item.href, $page.url.pathname)}>
          <span class="bar"></span>
          <Icon name={item.icon} size={17} />
          <span class="text">{item.label}</span>
          <Icon name="chevronRight" size={14} class="chev" />
        </a>
      </li>
    {/each}
  </ul>

  <div class="foot">
    <div class="foot-label">System</div>
    <div class="foot-row">
      <span>Robots</span>
      <span class="mono">{robot.robots.length}</span>
    </div>
    <div class="foot-row">
      <span>Online</span>
      <span class="mono" class:live={robot.anyOnline}>{robot.onlineCount}/{robot.robots.length}</span>
    </div>
    <div class="ver">v0.1.0 · BETA</div>
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-w);
    flex: none;
    background: var(--bg-elev-1);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 14px 12px;
    overflow-y: auto;
  }
  .nav {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .nav-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .nav-item :global(.chev) {
    margin-left: auto;
    opacity: 0;
    color: var(--gold);
    transition: opacity var(--transition);
  }
  .bar {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 0;
    background: var(--gold);
    border-radius: 0 3px 3px 0;
    transition: height var(--transition);
  }
  .nav-item:hover {
    color: var(--text-primary);
    background: var(--bg-elev-2);
  }
  .nav-item.active {
    color: var(--gold-bright);
    background: var(--gold-tint);
  }
  .nav-item.active .bar {
    height: 60%;
  }
  .nav-item.active :global(.chev) {
    opacity: 1;
  }

  .foot {
    padding: 12px;
    border-top: 1px solid var(--border-soft);
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .foot-label {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 2px;
  }
  .foot-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .foot-row .mono {
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .foot-row .mono.live {
    color: var(--green);
  }
  .ver {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--text-faint);
  }
</style>
