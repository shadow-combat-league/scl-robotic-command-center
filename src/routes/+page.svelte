<script lang="ts">
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Button from "$lib/components/Button.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import StatusPill from "$lib/components/StatusPill.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { robot } from "$lib/services/robot.svelte";
  import type { RobotProfile } from "$lib/services/types";

  let pendingDelete = $state<RobotProfile | null>(null);

  function confirmDelete() {
    if (pendingDelete) robot.remove(pendingDelete.id);
    pendingDelete = null;
  }

  const QUICK = [
    { href: "/setup", icon: "setup", title: "Onboard a Robot", desc: "Guided step-by-step setup" },
    { href: "/robot", icon: "robot", title: "Robot Console", desc: "Live status & controls for all" },
    { href: "/motions", icon: "motion", title: "Deploy Motion", desc: "Send a routine to the robot" },
    { href: "/settings", icon: "settings", title: "Settings", desc: "Profiles, network & firmware" },
  ];

  const CONN = {
    disconnected: { tone: "muted", label: "Offline" },
    connecting: { tone: "gold", label: "Connecting" },
    online: { tone: "green", label: "Online" },
    error: { tone: "red", label: "Error" },
  } as const;

  const SEV_TONE = { success: "green", info: "cyan", warn: "gold", error: "red" } as const;

  function relTime(sec: number): string {
    if (sec < 60) return `${Math.round(sec)}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  }
  function battTone(b: number): string {
    return b > 40 ? "var(--green)" : b > 15 ? "var(--gold)" : "var(--red)";
  }
</script>

{#if !robot.hasRobots}
  <!-- First-run empty state -->
  <div class="empty">
    <span class="empty-icon"><Icon name="robot" size={36} /></span>
    <h1>No robots yet</h1>
    <p>
      Get started by onboarding your first robot. The guided wizard takes you from
      a powered-on robot to a network-connected, motion-ready machine in a few steps.
    </p>
    <Button variant="primary" icon="plus" href="/setup">Create Your First Robot</Button>
    <div class="empty-types">
      <span class="label">Supported</span>
      <span class="chip">Unitree G1</span>
      <span class="chip soon">EngineAI T800 · Coming soon</span>
    </div>
  </div>
{:else}
  <PageHeader eyebrow="Operator Console" title="Welcome, Operator" subtitle="Set up, monitor, and command your robots from one place.">
    {#snippet actions()}
      {#if robot.anyConnectable}
        <Button variant="secondary" icon="plug" onclick={() => robot.connectAll()}>Connect All</Button>
      {/if}
      {#if robot.anyOnline && !robot.allEstopped}
        <Button variant="danger" icon="power" onclick={() => robot.allStop()}>All-Stop</Button>
      {/if}
      <Button variant="primary" icon="plus" href="/setup">Add Robot</Button>
    {/snippet}
  </PageHeader>

  <div class="quick">
    {#each QUICK as q (q.href)}
      <a class="qcard" href={q.href}>
        <span class="qicon"><Icon name={q.icon} size={20} /></span>
        <span class="qtext">
          <span class="qtitle">{q.title}</span>
          <span class="qdesc">{q.desc}</span>
        </span>
        <Icon name="chevronRight" size={16} class="qarrow" />
      </a>
    {/each}
  </div>

  <div class="grid">
    <Panel title="Robots" icon="robot">
      {#snippet actions()}
        <Button variant="ghost" size="sm" icon="plus" href="/setup">Add</Button>
      {/snippet}

      <ul class="robots">
        {#each robot.robots as r (r.id)}
          {@const conn = robot.connectionOf(r.id)}
          {@const estopped = conn === "online" && robot.telemetryOf(r.id).estop}
          <li class="rrow" class:online={conn === "online"}>
            <span class="rmark"><Icon name="robot" size={18} /></span>
            <span class="rbody">
              <span class="rname">{r.name}</span>
              <span class="rmeta mono">{robot.modelName(r)} · {r.ip}{#if r.wifiSsid} · {r.wifiSsid}{/if}</span>
            </span>

            {#if estopped}
              <StatusPill tone="red" pulse>E-Stop</StatusPill>
            {:else}
              <StatusPill tone={CONN[conn].tone} pulse={conn === "online" || conn === "connecting"}>
                {CONN[conn].label}
              </StatusPill>
            {/if}
            {#if conn === "online"}
              <Button variant="ghost" size="sm" icon="plug" onclick={() => robot.disconnect(r.id)}>Disconnect</Button>
            {:else}
              <Button variant="secondary" size="sm" icon="plug" disabled={conn === "connecting"} onclick={() => robot.connect(r.id)}>
                {conn === "connecting" ? "…" : "Connect"}
              </Button>
            {/if}
            <button
              class="row-del"
              aria-label={`Delete ${r.name}`}
              title="Delete profile"
              onclick={() => (pendingDelete = r)}
            >
              <Icon name="trash" size={15} />
            </button>
          </li>
        {/each}
      </ul>
    </Panel>

    <div class="side">
      <Panel title="Fleet" icon="signal">
        {#snippet actions()}
          <span class="count mono"><span class:live={robot.anyOnline}>{robot.onlineCount}</span> / {robot.robots.length}</span>
        {/snippet}

        {#if robot.onlineRobots.length}
          <ul class="fleet">
            {#each robot.onlineRobots as r (r.id)}
              {@const t = robot.telemetryOf(r.id)}
              <li class="frow">
                <span class="fname">{r.name}</span>
                <span class="fbar"><span class="ffill" style="width:{t.battery}%;background:{battTone(t.battery)}"></span></span>
                <span class="fbatt mono">{t.battery}%</span>
              </li>
            {/each}
          </ul>
          <div class="fleet-actions">
            {#if robot.allEstopped}
              <Button variant="secondary" size="sm" icon="power" onclick={() => robot.releaseAll()}>Release All</Button>
            {:else}
              <Button variant="danger" size="sm" icon="power" onclick={() => robot.allStop()}>All-Stop</Button>
            {/if}
            <Button variant="ghost" size="sm" icon="robot" href="/robot">Console</Button>
          </div>
        {:else}
          <div class="offline">
            <Icon name="plug" size={22} />
            <p>No robots online. Connect one from the list to stream live telemetry.</p>
            {#if robot.anyConnectable}
              <Button variant="primary" size="sm" icon="plug" onclick={() => robot.connectAll()}>Connect All</Button>
            {/if}
          </div>
        {/if}
      </Panel>

      <Panel title="Activity" icon="clock">
        {#if robot.activity.length}
          <ul class="feed">
            {#each robot.activity.slice(0, 6) as ev (ev.id)}
              <li class="ev">
                <span class="ev-dot {SEV_TONE[ev.severity]}"></span>
                <span class="ev-msg">{ev.message}</span>
                <span class="ev-time mono">{relTime(ev.agoSec)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="feed-empty">No activity yet.</p>
        {/if}
      </Panel>
    </div>
  </div>

  {#if pendingDelete}
    <ConfirmDialog
      title="Delete robot profile?"
      message={`“${pendingDelete.name}” and its saved network settings will be removed from this computer. This can’t be undone.`}
      confirmLabel="Delete"
      danger
      onConfirm={confirmDelete}
      onClose={() => (pendingDelete = null)}
    />
  {/if}
{/if}

<style>
  /* --- empty state --- */
  .empty { max-width: 520px; margin: 8vh auto 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; }
  .empty-icon { display: grid; place-items: center; width: 76px; height: 76px; border-radius: var(--r-lg); background: var(--gold-tint); color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 28%, transparent); box-shadow: var(--shadow-glow-gold); }
  .empty h1 { font-size: 26px; }
  .empty p { color: var(--text-secondary); font-size: 14px; }
  .empty-types { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .chip { font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.06em; color: var(--text-secondary); padding: 4px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--bg-elev-2); }
  .chip.soon { color: var(--text-faint); border-style: dashed; }

  /* --- quick actions --- */
  .quick { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .qcard { display: flex; align-items: center; gap: 13px; padding: 15px; background: var(--bg-elev-1); border: 1px solid var(--border); border-radius: var(--r-lg); color: var(--text-primary); transition: all var(--transition); }
  .qcard:hover { border-color: var(--gold); background: var(--bg-elev-2); transform: translateY(-2px); box-shadow: var(--shadow-glow-gold); }
  .qicon { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: var(--r-md); background: var(--gold-tint); color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent); }
  .qtext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .qtitle { font-weight: 600; font-size: 13.5px; }
  .qdesc { font-size: 12px; color: var(--text-muted); }
  .qcard :global(.qarrow) { margin-left: auto; color: var(--text-faint); transition: all var(--transition); }
  .qcard:hover :global(.qarrow) { color: var(--gold); transform: translateX(2px); }

  /* --- layout grid --- */
  .grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr); gap: 18px; align-items: start; }
  .side { display: flex; flex-direction: column; gap: 18px; }

  /* --- robots list --- */
  .robots { list-style: none; display: flex; flex-direction: column; }
  .rrow { display: flex; align-items: center; gap: 13px; padding: 13px 6px; border-top: 1px solid var(--border-soft); }
  .rrow:first-child { border-top: none; }
  .rmark { display: grid; place-items: center; width: 38px; height: 38px; flex: none; border-radius: var(--r-md); background: var(--bg-elev-2); border: 1px solid var(--border-strong); color: var(--text-secondary); }
  .rrow.online .rmark { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-tint); }
  .rbody { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin-right: auto; }
  .rname { font-weight: 600; font-size: 13.5px; }
  .rmeta { font-size: 11.5px; color: var(--text-muted); }
  .row-del {
    display: grid; place-items: center;
    width: 30px; height: 30px;
    flex: none;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-faint);
    transition: all var(--transition);
  }
  .row-del:hover { color: var(--red-bright); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-tint); }

  /* --- fleet panel --- */
  .count { font-size: 13px; color: var(--text-muted); }
  .count .live { color: var(--green); font-weight: 600; }
  .fleet { list-style: none; display: flex; flex-direction: column; gap: 11px; margin-bottom: 14px; }
  .frow { display: flex; align-items: center; gap: 11px; }
  .fname { font-size: 12.5px; font-weight: 600; min-width: 84px; }
  .fbar { flex: 1; height: 6px; background: var(--bg-elev-3); border-radius: var(--r-pill); overflow: hidden; }
  .ffill { display: block; height: 100%; border-radius: var(--r-pill); transition: width 400ms ease; }
  .fbatt { font-size: 12px; color: var(--text-secondary); min-width: 38px; text-align: right; }
  .fleet-actions { display: flex; gap: 8px; }

  .offline { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; padding: 18px 8px 6px; color: var(--text-muted); }
  .offline :global(svg) { color: var(--text-faint); }
  .offline p { font-size: 13px; color: var(--text-secondary); max-width: 32ch; }

  /* --- activity --- */
  .feed { list-style: none; display: flex; flex-direction: column; }
  .ev { display: flex; align-items: center; gap: 11px; padding: 9px 2px; border-top: 1px solid var(--border-soft); font-size: 12.5px; }
  .ev:first-child { border-top: none; }
  .ev-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .ev-dot.green { background: var(--green); }
  .ev-dot.cyan { background: var(--cyan); }
  .ev-dot.gold { background: var(--gold); }
  .ev-dot.red { background: var(--red); }
  .ev-msg { color: var(--text-secondary); margin-right: auto; }
  .ev-time { color: var(--text-faint); font-size: 11px; flex: none; }
  .feed-empty { color: var(--text-muted); font-size: 13px; text-align: center; padding: 12px; }

  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
  }
</style>
