<script lang="ts">
  import Icon from "./Icon.svelte";
  import Button from "./Button.svelte";
  import StatusPill from "./StatusPill.svelte";
  import Spinner from "./Spinner.svelte";
  import { robot } from "$lib/services/robot.svelte";
  import { robotTypeSpec } from "$lib/services/robotTypes";
  import type { RobotProfile } from "$lib/services/types";

  interface Props {
    profile: RobotProfile;
    expanded?: boolean;
    onToggle?: () => void;
    onDelete?: () => void;
  }
  let { profile, expanded = false, onToggle, onDelete }: Props = $props();

  const CONN = {
    disconnected: { tone: "muted", label: "Offline" },
    connecting: { tone: "gold", label: "Connecting" },
    online: { tone: "green", label: "Online" },
    error: { tone: "red", label: "Error" },
  } as const;

  let conn = $derived(robot.connectionOf(profile.id));
  let tel = $derived(robot.telemetryOf(profile.id));
  let posture = $derived(robot.postureOf(profile.id));
  // Robot-specific fields (battery/temp/joints) are only meaningful when the
  // agent reports them live via DDS; undefined (mock) counts as available.
  let robotAvail = $derived(tel.robotStateAvailable !== false);
  let cmd = $derived(robot.commandStateOf(profile.id));
  let estopped = $derived(conn === "online" && tel.estop);

  // High-level modes commanded on the robot (maps to the agent's LocoClient actions).
  const MODES: { key: string; label: string }[] = [
    { key: "damp", label: "Damp" },
    { key: "sit", label: "Sit" },
    { key: "stand", label: "Locked Standing" },
    { key: "run", label: "Run" },
  ];
  // Friendly label for a command key (the key is the agent's protocol token).
  function modeLabel(key: string): string {
    return MODES.find((m) => m.key === key)?.label ?? key;
  }

  function uptime(sec: number): string {
    return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
  }
  function battTone(b: number): string {
    return b > 40 ? "var(--green)" : b > 15 ? "var(--gold)" : "var(--red)";
  }
</script>

<article class="card" class:online={conn === "online"} class:estop={estopped}>
  <header class="head">
    <span class="mark"><Icon name="robot" size={18} /></span>
    <span class="id">
      <span class="name">{profile.name}</span>
      <span class="model mono">{robot.modelName(profile)}</span>
    </span>
    {#if estopped}
      <StatusPill tone="red" pulse>E-Stopped</StatusPill>
    {:else}
      <StatusPill tone={CONN[conn].tone} pulse={conn === "online" || conn === "connecting"}>
        {CONN[conn].label}
      </StatusPill>
    {/if}
    {#if onToggle}
      <button class="expand" class:open={expanded} onclick={onToggle} aria-label="Expand">
        <Icon name="chevronRight" size={16} />
      </button>
    {/if}
    {#if onDelete}
      <button class="del" aria-label={`Delete ${profile.name}`} title="Delete profile" onclick={onDelete}>
        <Icon name="trash" size={15} />
      </button>
    {/if}
  </header>

  {#if conn === "connecting"}
    <div class="state"><Spinner /> Connecting to {profile.ip}…</div>
  {:else if conn !== "online"}
    <div class="offline">
      <span class="meta mono">{profile.sshUser}@{profile.ip}{#if profile.wifiSsid} · {profile.wifiSsid}{/if}</span>
      {#if conn === "error"}
        <span class="meta err">Unreachable at {profile.ip}.</span>
      {/if}
      <div class="offline-actions">
        <Button variant="primary" size="sm" icon="plug" onclick={() => robot.connect(profile.id)}>Connect</Button>
        <Button variant="ghost" size="sm" icon="setup" href={`/setup?reonboard=${profile.id}`}>Fix Wi-Fi</Button>
      </div>
    </div>
  {:else}
    <!-- live telemetry -->
    <div class="stats">
      <div class="stat batt">
        <span class="stat-top"><Icon name="battery" size={15} /><span class="stat-key">Battery</span><span class="stat-val mono">{robotAvail ? `${tel.battery}%` : "—"}</span></span>
        <span class="bar"><span class="fill" style="width:{robotAvail ? tel.battery : 0}%;background:{battTone(tel.battery)}"></span></span>
      </div>
      <div class="stat"><Icon name="temp" size={15} /><span class="stat-key">Temp</span><span class="stat-val mono">{robotAvail ? `${tel.temperature}°` : "—"}</span></div>
      <div class="stat"><Icon name="cpu" size={15} /><span class="stat-key">CPU</span><span class="stat-val mono">{tel.cpuLoad}%</span></div>
      <div class="stat"><Icon name="cube" size={15} /><span class="stat-key">Memory</span><span class="stat-val mono">{tel.memory != null ? `${tel.memory}%` : "—"}</span></div>
      <div class="stat"><Icon name="clock" size={15} /><span class="stat-key">Uptime</span><span class="stat-val mono">{uptime(tel.uptimeSec)}</span></div>
    </div>

    <div class="controls">
      <span class="ctl-label label">Mode</span>
      <div class="ctl-btns">
        {#each MODES as m (m.key)}
          <button
            class="ctl"
            class:active={posture === m.key}
            disabled={estopped || cmd?.phase === "sending"}
            onclick={() => robot.setPosture(profile.id, m.key)}
          >{m.label}</button>
        {/each}
      </div>
      {#if cmd}
        <div class="cmd" class:err={cmd.phase === "error"} class:ok={cmd.phase === "ok"}>
          {#if cmd.phase === "sending"}
            <Spinner size={12} /> <span>Sending “{modeLabel(cmd.action)}”…</span>
          {:else if cmd.phase === "error"}
            <Icon name="alert" size={13} /> <span>“{modeLabel(cmd.action)}” failed — {cmd.msg}</span>
          {:else}
            <Icon name="check" size={13} /> <span>{cmd.msg || `${modeLabel(cmd.action)} engaged`}</span>
          {/if}
        </div>
      {/if}
    </div>

    {#if expanded}
      <dl class="detail">
        <div><dt>Joints</dt><dd class="mono" class:ok={robotAvail && tel.jointsOk}>{robotAvail ? (tel.jointsOk ? "23 / 23 OK" : "FAULT") : "—"}</dd></div>
        <div><dt>Posture</dt><dd class="mono">{posture}</dd></div>
        <div><dt>Firmware</dt><dd class="mono">{robotTypeSpec(profile.type).vendor} · {profile.type}</dd></div>
        <div><dt>Address</dt><dd class="mono">{profile.ip}</dd></div>
        <div><dt>Host</dt><dd class="mono">{tel.hostname ?? "—"}</dd></div>
        <div><dt>Wi-Fi</dt><dd class="mono">{profile.wifiSsid ?? "—"}</dd></div>
      </dl>
    {/if}

    <footer class="foot">
      <Button
        variant={estopped ? "secondary" : "danger"}
        size="sm"
        icon="power"
        onclick={() => robot.toggleEstop(profile.id)}
      >
        {estopped ? "Release" : "E-Stop"}
      </Button>
      <Button variant="ghost" size="sm" icon="plug" onclick={() => robot.disconnect(profile.id)}>
        Disconnect
      </Button>
    </footer>
  {/if}
</article>

<style>
  .card {
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 15px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    transition: border-color var(--transition), box-shadow var(--transition);
  }
  .card.online {
    border-color: color-mix(in srgb, var(--green) 28%, var(--border));
  }
  .card.estop {
    border-color: color-mix(in srgb, var(--red) 55%, transparent);
    box-shadow: 0 0 0 1px var(--red-tint), 0 0 22px var(--red-tint);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: var(--r-md);
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
  }
  .card.online .mark { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 38%, transparent); background: var(--gold-tint); }
  .id { display: flex; flex-direction: column; gap: 1px; margin-right: auto; min-width: 0; }
  .name { font-weight: 650; font-size: 14px; }
  .model { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
  .expand {
    display: grid; place-items: center;
    width: 26px; height: 26px;
    flex: none;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    color: var(--text-muted);
    transition: transform var(--transition), color var(--transition);
  }
  .expand:hover { color: var(--gold); }
  .expand.open { transform: rotate(90deg); color: var(--gold); }
  .del {
    display: grid; place-items: center;
    width: 26px; height: 26px;
    flex: none;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    color: var(--text-faint);
    transition: all var(--transition);
  }
  .del:hover { color: var(--red-bright); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-tint); }

  .state {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 2px;
    font-family: var(--font-mono); font-size: 12.5px; color: var(--text-secondary);
  }
  .offline {
    display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  }
  .offline .meta { font-size: 11.5px; color: var(--text-muted); }
  .offline .meta.err { color: var(--red-bright); }
  .offline-actions { display: flex; gap: 8px; }

  /* telemetry */
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px;
  }
  .stat {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 11px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }
  .stat :global(svg) { color: var(--gold); flex: none; }
  .stat-key { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); }
  .stat-val { margin-left: auto; font-size: 14px; font-weight: 600; }
  .stat.batt { grid-column: 1 / -1; flex-direction: column; align-items: stretch; gap: 7px; }
  .stat.batt .stat-top { display: flex; align-items: center; gap: 8px; }
  .stat.batt .stat-top :global(svg) { color: var(--gold); }
  .bar { height: 5px; background: var(--bg-elev-3); border-radius: var(--r-pill); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: var(--r-pill); transition: width 400ms ease; }

  /* controls */
  .controls { display: flex; flex-direction: column; gap: 7px; }
  .ctl-label { color: var(--text-muted); }
  .ctl-btns { display: flex; gap: 7px; }
  .ctl {
    flex: 1;
    padding: 8px 0;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    font-family: var(--font-mono); font-size: 11px; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .ctl:hover:not(:disabled) { border-color: var(--gold); color: var(--gold-bright); }
  .ctl.active { background: var(--gold-tint); border-color: var(--gold); color: var(--gold-bright); }
  .ctl:disabled { opacity: 0.4; }

  .cmd {
    display: flex; align-items: center; gap: 7px;
    margin-top: 2px;
    font-family: var(--font-mono); font-size: 11px; line-height: 1.4;
    color: var(--text-secondary);
  }
  .cmd :global(svg) { flex: none; color: var(--text-secondary); }
  .cmd.ok, .cmd.ok :global(svg) { color: var(--green-bright); }
  .cmd.err, .cmd.err :global(svg) { color: var(--red-bright); }
  .cmd span { min-width: 0; word-break: break-word; }

  /* detail (expanded) */
  .detail { display: flex; flex-direction: column; border-top: 1px solid var(--border-soft); padding-top: 4px; }
  .detail div { display: flex; justify-content: space-between; padding: 7px 2px; border-top: 1px solid var(--border-soft); font-size: 12px; }
  .detail div:first-child { border-top: none; }
  .detail dt { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); }
  .detail dd { color: var(--text-primary); }
  .detail dd.ok { color: var(--green); }

  .foot { display: flex; gap: 8px; }
  .foot :global(.btn) { flex: 1; }
</style>
