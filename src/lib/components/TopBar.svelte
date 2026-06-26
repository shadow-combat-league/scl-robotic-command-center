<script lang="ts">
  import Logo from "./Logo.svelte";
  import Button from "./Button.svelte";
  import Icon from "./Icon.svelte";
  import { robot } from "$lib/services/robot.svelte";

  function chipTone(id: string): "green" | "gold" | "red" | "muted" {
    const c = robot.connectionOf(id);
    if (c === "online") return robot.telemetryOf(id).estop ? "red" : "green";
    if (c === "connecting") return "gold";
    if (c === "error") return "red";
    return "muted";
  }
</script>

<header class="topbar">
  <Logo />

  <div class="right">
    {#if !robot.hasRobots}
      <Button size="sm" variant="primary" icon="plus" href="/setup">Add Robot</Button>
    {:else}
      <a class="fleet" href="/robot" title="Open robot console">
        {#each robot.robots as r (r.id)}
          <span class="chip {chipTone(r.id)}">
            <span class="dot"></span>{r.name}
          </span>
        {/each}
      </a>

      {#if robot.anyOnline}
        {#if robot.allEstopped}
          <Button size="sm" variant="secondary" icon="power" onclick={() => robot.releaseAll()}>
            Release
          </Button>
        {:else}
          <Button size="sm" variant="danger" icon="power" onclick={() => robot.allStop()}>
            All-Stop
          </Button>
        {/if}
      {/if}

      <Button size="sm" variant="ghost" icon="plus" href="/setup">Add</Button>
    {/if}
  </div>
</header>

<style>
  .topbar {
    height: var(--topbar-h);
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 18px;
    background: linear-gradient(180deg, #0c0f16, var(--bg-elev-1));
    border-bottom: 1px solid var(--border);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .fleet {
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: 46vw;
    overflow: hidden;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 11px;
    border-radius: var(--r-pill);
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    font-family: var(--font-mono);
    font-size: 11.5px;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    white-space: nowrap;
    transition: border-color var(--transition), color var(--transition);
  }
  .fleet:hover .chip {
    color: var(--text-primary);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    background: currentColor;
  }
  .chip.green { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .chip.gold { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 40%, transparent); }
  .chip.red { color: var(--red-bright); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
  .chip.muted { color: var(--text-muted); }
  .chip.green,
  .chip.gold,
  .chip.red {
    background: var(--bg-elev-2);
  }
</style>
