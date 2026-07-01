<script lang="ts">
  import { tick } from "svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Button from "$lib/components/Button.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import Spinner from "$lib/components/Spinner.svelte";
  import StatusPill from "$lib/components/StatusPill.svelte";
  import StreamView from "$lib/components/StreamView.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { robot } from "$lib/services/robot.svelte";
  import { headsets, type Headset } from "$lib/services/headsets.svelte";
  import type { RobotProfile } from "$lib/services/types";

  const STATE = {
    stopped: { tone: "muted", label: "Idle" },
    starting: { tone: "gold", label: "Starting" },
    running: { tone: "green", label: "Running" },
    error: { tone: "red", label: "Error" },
  } as const;

  let fullscreen = $state(false);
  let fsEl = $state<HTMLElement | null>(null);

  async function enterFullscreen() {
    fullscreen = true;
    await tick();
    try {
      await fsEl?.requestFullscreen?.();
    } catch {
      /* fall back to in-app immersive overlay */
    }
  }
  function exitFullscreen() {
    fullscreen = false;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
  function onFsChange() {
    // user pressed Esc / F11 out of native fullscreen
    if (!document.fullscreenElement && fullscreen) fullscreen = false;
  }

  /** Status dot tone for the fullscreen header chips. */
  function chipTone(r: RobotProfile): "green" | "gold" | "red" | "muted" {
    if (robot.connectionOf(r.id) === "online" && robot.telemetryOf(r.id).estop) return "red";
    const st = robot.teleopStateOf(r.id);
    if (st === "running") return "green";
    if (st === "starting") return "gold";
    if (st === "error") return "red";
    return "muted";
  }

  // Teleop must start from Running Mode. If not, gate the start behind a dialog
  // that offers to switch the affected robot(s) into Running Mode first.
  let gateIds = $state<string[] | null>(null);
  let gateNames = $derived(
    (gateIds ?? []).map((id) => robot.robots.find((r) => r.id === id)?.name ?? "robot"),
  );
  function requestTeleop(id: string) {
    if (!robot.isInRunningMode(id)) {
      gateIds = [id];
      return;
    }
    robot.startTeleop(id);
  }
  function requestTeleopAll() {
    const notReady = robot.robots
      .filter((r) => robot.teleopStateOf(r.id) === "stopped" && !robot.isInRunningMode(r.id))
      .map((r) => r.id);
    if (notReady.length) {
      gateIds = notReady;
      return;
    }
    robot.startTeleopAll();
  }
  function switchToRunning() {
    for (const id of gateIds ?? []) robot.setPosture(id, "run");
    gateIds = null;
  }

  // ---- per-robot headset assignment ----
  // The headset appointed to this robot (paired to its service port), if any.
  function assignedHeadset(robotId: string): Headset | undefined {
    return headsets.headsets.find((h) => h.assignedRobotId === robotId);
  }
  // Online headsets free to assign here (unassigned, or already this robot's).
  function availableHeadsets(robotId: string): Headset[] {
    return headsets.headsets.filter(
      (h) => h.online && (!h.assignedRobotId || h.assignedRobotId === robotId),
    );
  }
  function assignHeadset(robotId: string, headsetId: string) {
    if (headsetId) headsets.pairToRobot(headsetId, robotId);
  }
</script>

<svelte:window onfullscreenchange={onFsChange} />

{#snippet card(r: RobotProfile)}
  {@const st = robot.teleopStateOf(r.id)}
  {@const ah = assignedHeadset(r.id)}
  <article class="tcard" class:running={st === "running"}>
    <header class="thead">
      <span class="tmark"><Icon name="robot" size={17} /></span>
      <span class="tid">
        <span class="tname">{r.name}</span>
        <span class="tmodel mono">{robot.modelName(r)}</span>
      </span>
      <StatusPill tone={STATE[st].tone} pulse={st === "running" || st === "starting"}>
        {robot.teleopPausedOf(r.id) && st === "running" ? "Paused" : STATE[st].label}
      </StatusPill>
      {#if st === "running"}
        <Button
          size="sm"
          variant={robot.teleopPausedOf(r.id) ? "primary" : "ghost"}
          icon={robot.teleopPausedOf(r.id) ? "play" : "pause"}
          onclick={() => robot.setTeleopPaused(r.id, !robot.teleopPausedOf(r.id))}
        >
          {robot.teleopPausedOf(r.id) ? "Resume" : "Pause"}
        </Button>
      {/if}
    </header>

    <div class="hs-row">
      <span class="hs-label label">Headset</span>
      {#if ah}
        <span class="hs-on" title={`Paired to this PC :${robot.servicePortOf(r.id)}`}>
          <Icon name="check" size={12} />
          {ah.name}<span class="mono"> · :{robot.servicePortOf(r.id)}</span>
        </span>
        <button class="hs-btn" onclick={() => headsets.unpair(ah.id)}>Unassign</button>
      {:else}
        <select
          class="hs-sel"
          aria-label={`Assign a headset to ${r.name}`}
          onchange={(e) => assignHeadset(r.id, e.currentTarget.value)}
        >
          <option value="">Assign a headset…</option>
          {#each availableHeadsets(r.id) as h (h.id)}
            <option value={h.id}>{h.name}{h.battery != null ? ` · ${h.battery}%` : ""}</option>
          {/each}
        </select>
        <button class="hs-btn" onclick={() => headsets.discover()} disabled={headsets.scanning}>
          {headsets.scanning ? "Scanning…" : "Scan"}
        </button>
      {/if}
    </div>

    <div class="tbody">
      {#if st === "running"}
        <StreamView
          title="3D Motion Preview"
          url={robot.meshcatUrlOf(r.id)}
          name={r.name}
          fill={fullscreen}
          onStop={() => robot.stopTeleop(r.id)}
        />
      {:else if st === "starting"}
        <div class="tstate"><Spinner size={20} /> Launching teleoperation script…</div>
      {:else if st === "error"}
        <div class="tstate idle">
          <Icon name="alert" size={22} />
          <p>Teleoperation failed to start.</p>
          <Button variant="primary" size="sm" icon="play" onclick={() => requestTeleop(r.id)}>Retry</Button>
        </div>
      {:else}
        <div class="tstate idle">
          <span class="cube"><Icon name="cube" size={28} /></span>
          <p>Teleoperation is not running. Start the script to view <strong>{r.name}</strong>'s live 3D state.</p>
          <Button variant="primary" size="sm" icon="play" onclick={() => requestTeleop(r.id)}>Start Teleoperation</Button>
        </div>
      {/if}
    </div>
  </article>
{/snippet}

{#if fullscreen}
  <!-- ===================== IMMERSIVE FULLSCREEN ===================== -->
  <div class="fs" bind:this={fsEl}>
    <header class="fs-head">
      <span class="fs-title label">Teleoperate</span>
      <div class="fs-chips">
        {#each robot.robots as r (r.id)}
          <span class="chip {chipTone(r)}"><span class="dot"></span>{r.name}</span>
        {/each}
      </div>
      <span class="fs-count mono">
        <span class:live={robot.teleopRunningCount > 0}>{robot.teleopRunningCount}</span>/{robot.robots.length} teleoperating
      </span>
      <div class="fs-actions">
        {#if robot.anyOnline && !robot.allEstopped}
          <Button variant="danger" size="sm" icon="power" onclick={() => robot.allStop()}>All-Stop</Button>
        {/if}
        <Button variant="secondary" size="sm" icon="minimize" onclick={exitFullscreen}>Exit</Button>
      </div>
    </header>

    <div class="fs-grid">
      {#each robot.robots as r (r.id)}
        {@render card(r)}
      {/each}
    </div>
  </div>
{:else}
  <!-- ===================== NORMAL ===================== -->
  <PageHeader
    eyebrow="Live"
    title="Teleoperate"
    subtitle="Run the teleoperation script for each robot and watch its live 3D state, streamed from Meshcat."
  >
    {#snippet actions()}
      {#if robot.hasRobots}
        <Button variant="ghost" size="sm" icon="maximize" onclick={enterFullscreen}>Fullscreen</Button>
      {/if}
      {#if robot.anyTeleopStartable}
        <Button variant="secondary" size="sm" icon="play" onclick={() => requestTeleopAll()}>Start All</Button>
      {/if}
      {#if robot.anyTeleopActive}
        <Button variant="ghost" size="sm" icon="power" onclick={() => robot.stopTeleopAll()}>Stop All</Button>
      {/if}
      <Button variant="primary" size="sm" icon="plus" href="/setup">Add Robot</Button>
    {/snippet}
  </PageHeader>

  {#if !robot.hasRobots}
    <div class="empty">
      <span class="empty-icon"><Icon name="cube" size={30} /></span>
      <p>No robots yet. Onboard one to teleoperate it.</p>
      <Button variant="primary" icon="plus" href="/setup">Add Robot</Button>
    </div>
  {:else}
    <div class="tbar">
      <span class="count">
        <span class="num mono" class:live={robot.teleopRunningCount > 0}>{robot.teleopRunningCount}</span>
        <span class="den mono">/ {robot.robots.length}</span>
        <span class="lbl label">Teleoperating</span>
      </span>
    </div>

    <div class="grid">
      {#each robot.robots as r (r.id)}
        <div class="cell">{@render card(r)}</div>
      {/each}
    </div>
  {/if}
{/if}

{#if gateIds}
  <ConfirmDialog
    title="Switch to Running Mode?"
    message={`Teleoperation must start from Running Mode. Switch ${
      gateNames.length === 1 ? gateNames[0] : `${gateNames.length} robots`
    } to Running Mode now, then press Start once the robot is standing.`}
    confirmLabel="Switch to Running Mode"
    onConfirm={switchToRunning}
    onClose={() => (gateIds = null)}
  />
{/if}

<style>
  /* ---- shared card ---- */
  .tcard {
    display: flex;
    flex-direction: column;
    gap: 13px;
    padding: 14px;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    transition: border-color var(--transition);
  }
  .tcard.running { border-color: color-mix(in srgb, var(--green) 28%, var(--border)); }
  .thead { display: flex; align-items: center; gap: 11px; }
  .tmark {
    display: grid; place-items: center; width: 34px; height: 34px; flex: none;
    border-radius: var(--r-md); background: var(--bg-elev-2); border: 1px solid var(--border-strong); color: var(--text-secondary);
  }
  .tcard.running .tmark { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 38%, transparent); background: var(--gold-tint); }
  .tid { display: flex; flex-direction: column; gap: 1px; margin-right: auto; min-width: 0; }
  .tname { font-weight: 650; font-size: 14px; }
  .tmodel { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }

  /* ---- headset assignment row ---- */
  .hs-row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .hs-label { color: var(--text-muted); flex: none; }
  .hs-on {
    display: inline-flex; align-items: center; gap: 6px; min-width: 0;
    color: var(--green); font-size: 12.5px; font-weight: 600;
  }
  .hs-on .mono { color: var(--text-muted); font-weight: 400; }
  .hs-sel {
    flex: 1; min-width: 0; height: 30px; padding: 0 8px;
    background: var(--bg-elev-2); color: var(--text-primary);
    border: 1px solid var(--border-strong); border-radius: var(--r-md); font-size: 12.5px;
  }
  .hs-btn {
    flex: none; height: 30px; padding: 0 11px; cursor: pointer;
    background: var(--bg-elev-2); color: var(--text-secondary);
    border: 1px solid var(--border-strong); border-radius: var(--r-md); font-size: 12px;
  }
  .hs-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--gold); }
  .hs-btn:disabled { opacity: 0.5; cursor: default; }

  .tbody { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .tstate {
    display: flex; align-items: center; justify-content: center; gap: 11px;
    flex: 1; min-height: 200px; padding: 20px;
    border: 1px dashed var(--border-strong); border-radius: var(--r-md);
    font-family: var(--font-mono); font-size: 12.5px; color: var(--text-secondary); background: var(--bg-base);
  }
  .tstate.idle { flex-direction: column; text-align: center; font-family: var(--font-sans); }
  .tstate.idle p { font-size: 13px; color: var(--text-secondary); max-width: 38ch; }
  .tstate.idle strong { color: var(--text-primary); }
  .tstate.idle :global(svg) { color: var(--red-bright); }
  .cube {
    display: grid; place-items: center; width: 56px; height: 56px;
    border-radius: var(--r-lg); background: var(--gold-tint); color: var(--gold);
    border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent);
  }

  /* ---- normal layout ---- */
  .tbar { display: flex; align-items: center; margin-bottom: 16px; }
  .count { display: inline-flex; align-items: baseline; gap: 7px; }
  .num { font-size: 24px; font-weight: 700; color: var(--text-muted); }
  .num.live { color: var(--green); }
  .den { font-size: 16px; color: var(--text-muted); }
  .lbl { margin-left: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; align-items: start; }

  .empty {
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 13px; padding: 56px 24px;
    background: var(--bg-elev-1); border: 1px dashed var(--border-strong); border-radius: var(--r-lg);
  }
  .empty-icon {
    display: grid; place-items: center; width: 64px; height: 64px; border-radius: var(--r-lg);
    background: var(--gold-tint); color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent);
  }
  .empty p { color: var(--text-secondary); font-size: 14px; }

  /* ---- fullscreen ---- */
  .fs {
    position: fixed;
    inset: 0;
    z-index: 300;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
  }
  .fs-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    height: 52px;
    padding: 0 16px;
    background: linear-gradient(180deg, #0c0f16, var(--bg-elev-1));
    border-bottom: 1px solid var(--border);
  }
  .fs-title { color: var(--gold); flex: none; }
  .fs-chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 11px;
    border-radius: var(--r-pill); background: var(--bg-elev-2); border: 1px solid var(--border-strong);
    font-family: var(--font-mono); font-size: 11.5px; color: var(--text-secondary); white-space: nowrap;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: currentColor; }
  .chip.green { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .chip.gold { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 40%, transparent); }
  .chip.red { color: var(--red-bright); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
  .chip.muted { color: var(--text-muted); }
  .fs-count { font-size: 12px; color: var(--text-muted); margin-left: auto; flex: none; }
  .fs-count .live { color: var(--green); font-weight: 600; }
  .fs-actions { display: flex; gap: 8px; flex: none; }

  .fs-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
    grid-auto-rows: 1fr;
    gap: 14px;
    padding: 14px;
    overflow: auto;
  }
  .fs-grid .tcard { height: 100%; min-height: 0; }
</style>
