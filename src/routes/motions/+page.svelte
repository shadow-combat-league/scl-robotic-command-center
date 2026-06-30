<script lang="ts">
  import { onMount } from "svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Button from "$lib/components/Button.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import Spinner from "$lib/components/Spinner.svelte";
  import StatusPill from "$lib/components/StatusPill.svelte";
  import StreamView from "$lib/components/StreamView.svelte";
  import { library, type ImportedMotion } from "$lib/services/motions.svelte";
  import { robot } from "$lib/services/robot.svelte";
  import { ROBOT_TYPES } from "$lib/services/robotTypes";
  import type { RobotType } from "$lib/services/types";
  import { isTauri, pickMotionFile, pickPolicyFile } from "$lib/services/tauri";

  let motionInput: HTMLInputElement;
  let policyInput: HTMLInputElement;
  let pendingPolicy = $state<{ name: string; path?: string; file?: File } | null>(null);

  // "Play on robots" picker
  let playFor = $state<ImportedMotion | null>(null);
  let playSelected = $state<string[]>([]);
  let session = $derived(library.playSession);

  function phaseLabel(phase?: string): string {
    switch (phase) {
      case "starting": return "Starting stream…";
      case "connecting": return "Connecting to robot…";
      case "ramping": return "Ramping into frame 0…";
      case "holding": return "Holding at frame 0";
      case "playing": return "Streaming";
      case "ended": return "Reached end";
      case "error": return "Failed";
      case "stopped": return "Stopped";
      default: return "Starting…";
    }
  }

  onMount(() => library.load());

  function openPlay(motion: ImportedMotion) {
    playFor = motion;
    playSelected = robot.onlineRobots.map((r) => r.id); // default: all connected
  }
  function togglePlayRobot(id: string) {
    playSelected = playSelected.includes(id)
      ? playSelected.filter((x) => x !== id)
      : [...playSelected, id];
  }
  function confirmPlay() {
    if (!playFor || playSelected.length === 0) return;
    library.startPlaySession(playFor, playSelected);
    playFor = null;
    playSelected = [];
  }

  // In the desktop app: native dialog → absolute path → auto-spawned Meshcat
  // preview. In the browser: fall back to the HTML file input (mock preview).
  async function importMotion() {
    if (isTauri()) {
      const path = await pickMotionFile();
      if (path) await library.importMotionFromPath(path);
    } else {
      motionInput?.click();
    }
  }

  async function onPickMotion(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await library.importMotionFromFile(file);
    input.value = "";
  }
  async function importPolicy() {
    if (isTauri()) {
      const path = await pickPolicyFile();
      if (path) pendingPolicy = { name: path.split(/[/\\]/).pop() || path, path };
    } else {
      policyInput?.click();
    }
  }
  function onPickPolicy(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) pendingPolicy = { name: file.name, file }; // ask which robot first
    input.value = "";
  }
  function choosePolicyRobot(robot: RobotType) {
    if (ROBOT_TYPES.find((r) => r.id === robot)?.comingSoon) return; // not yet available
    const p = pendingPolicy;
    pendingPolicy = null;
    if (!p) return;
    if (p.path) library.importPolicyFromPath(p.path, robot);
    else if (p.file) library.importPolicy(p.file, robot);
  }

  function robotName(t: RobotType): string {
    return ROBOT_TYPES.find((r) => r.id === t)?.name ?? t;
  }
  function fmtTime(sec: number): string {
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  }
  function fmtSize(kb: number): string {
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
  }

  // Drive mock playback while a motion preview is running.
  $effect(() => {
    if (library.playing && library.previewState === "ready" && library.previewMotion) {
      const id = setInterval(() => library.tick(), 100);
      return () => clearInterval(id);
    }
  });

  let mtn = $derived(library.previewMotion);
  let pol = $derived(library.previewPolicy);
  let curTime = $derived(mtn ? library.frame / mtn.fps : 0);
</script>

<input bind:this={motionInput} type="file" accept=".csv,text/csv" onchange={onPickMotion} hidden />
<input bind:this={policyInput} type="file" accept=".onnx" onchange={onPickPolicy} hidden />

{#if library.previewKind === "motion" && mtn}
  <!-- ===================== MOTION PREVIEW (Meshcat) ===================== -->
  <div class="preview">
    <PageHeader eyebrow="Motion Preview" title={mtn.name} subtitle="Live retarget preview, streamed from Meshcat.">
      {#snippet actions()}
        <div class="seg">
          {#each ROBOT_TYPES as t (t.id)}
            <button
              class="seg-btn"
              class:active={library.previewRobot === t.id}
              disabled={t.comingSoon}
              title={t.comingSoon ? "Coming soon" : null}
              onclick={() => library.setModel(t.id)}
            >{t.name}{#if t.comingSoon} · soon{/if}</button>
          {/each}
        </div>
        <Button variant="ghost" size="sm" icon="arrowLeft" onclick={() => library.closePreview()}>Library</Button>
      {/snippet}
    </PageHeader>

    <div class="meta-row">
      {#if mtn.frames > 0}
        <span class="chip mono"><Icon name="file" size={13} /> {mtn.frames} frames</span>
        <span class="chip mono">{fmtTime(mtn.durationSec)} @ {mtn.fps}fps</span>
        <span class="chip mono">{mtn.columns} DoF</span>
      {:else}
        <span class="chip mono"><Icon name="cube" size={13} /> {robotName(library.previewRobot)} · Meshcat</span>
      {/if}
    </div>

    {#if library.previewState === "loading"}
      <div class="loading-pane fill"><Spinner size={22} /> Loading {robotName(library.previewRobot)} model & retargeting motion…</div>
    {:else if library.previewState === "error"}
      <div class="loading-pane fill err"><Icon name="alert" size={20} /> {library.importError || "Preview failed to start."}</div>
    {:else if library.previewState === "ready"}
      <StreamView fill title="3D Motion Preview" url={library.previewUrl} name={mtn.name} stopLabel="Close preview" onStop={() => library.closePreview()} />
      {#if mtn.frames > 0}
        <div class="transport">
          <button class="play" onclick={() => library.togglePlay()} aria-label={library.playing ? "Pause" : "Play"}>
            <Icon name={library.playing ? "pause" : "play"} size={16} />
          </button>
          <span class="time mono">{fmtTime(curTime)}</span>
          <input class="scrub" type="range" min="0" max={mtn.frames - 1} value={library.frame} oninput={(e) => library.seek(Number((e.currentTarget as HTMLInputElement).value))} />
          <span class="time mono">{fmtTime(mtn.durationSec)}</span>
          <div class="seg">
            {#each [0.5, 1, 2] as s (s)}
              <button class="seg-btn" class:active={library.speed === s} onclick={() => library.setSpeed(s)}>{s}×</button>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>

{:else if library.previewKind === "policy" && pol}
  <!-- ===================== POLICY PREVIEW (Isaac Lab) ===================== -->
  <div class="preview">
    <PageHeader eyebrow="Policy Preview" title={pol.name} subtitle="Reinforcement-learning policy rollout in Isaac Lab.">
      {#snippet actions()}
        <StatusPill tone="gold" dot={false}>{robotName(pol.robot)}</StatusPill>
        <Button variant="ghost" size="sm" icon="arrowLeft" onclick={() => library.closePreview()}>Library</Button>
      {/snippet}
    </PageHeader>

    <div class="meta-row">
      <span class="chip mono"><Icon name="cpu" size={13} /> {robotName(pol.robot)}</span>
      <span class="chip mono">{fmtSize(pol.sizeKb)}</span>
      <span class="chip mono">ONNX</span>
    </div>

    {#if library.previewState === "loading"}
      <div class="loading-pane fill"><Spinner size={22} /> Starting Isaac Lab & loading policy onto {robotName(pol.robot)}…</div>
    {:else if library.previewState === "ready"}
      <StreamView fill title="Isaac Lab · Policy Rollout" url={library.previewUrl} name={pol.name} stopLabel="Stop rollout" onStop={() => library.closePreview()} />
    {/if}
  </div>

{:else}
  <!-- ===================== LIBRARY ===================== -->
  <PageHeader
    eyebrow="Library"
    title="Motions & Policies"
    subtitle="Import LAFAN1 motion datasets (.csv) to preview in Meshcat, or RL policies (.onnx) to roll out in Isaac Lab."
  >
    {#snippet actions()}
      <Button variant="secondary" icon="cpu" onclick={importPolicy}>Import Policy</Button>
      <Button variant="primary" icon="import" onclick={importMotion}>Import Motion</Button>
    {/snippet}
  </PageHeader>

  {#if library.importError}
    <div class="import-error"><Icon name="alert" size={15} /> {library.importError}</div>
  {/if}

  {#if library.motions.length === 0 && library.policies.length === 0}
    <div class="dropzone">
      <span class="dz-icon"><Icon name="import" size={30} /></span>
      <span class="dz-title">Import a motion or policy</span>
      <span class="dz-sub">A LAFAN1 <code>.csv</code> motion previews in Meshcat; an <code>.onnx</code> policy rolls out in Isaac Lab.</span>
      <div class="dz-actions">
        <Button variant="primary" icon="import" onclick={importMotion}>Import Motion</Button>
        <Button variant="secondary" icon="cpu" onclick={importPolicy}>Import Policy</Button>
      </div>
    </div>
  {:else}
    <div class="stack">
      {#if library.motions.length}
        <Panel title="Motions" icon="motion" flush>
          <ul class="list">
            {#each library.motions as item (item.id)}
              <li class="row">
                <span class="rmark"><Icon name="file" size={17} /></span>
                <span class="rbody">
                  <span class="rname">{item.name}</span>
                  <span class="rmeta mono">{item.frames} frames · {fmtTime(item.durationSec)} · {item.columns} DoF</span>
                </span>
                <StatusPill tone="cyan" dot={false}>LAFAN1</StatusPill>
                <Button variant="ghost" size="sm" icon="cube" onclick={() => library.openMotionPreview(item.id)}>Preview</Button>
                <Button variant="secondary" size="sm" icon="play" onclick={() => openPlay(item)}>Play</Button>
                <button class="del" aria-label={`Remove ${item.name}`} title="Remove" onclick={() => library.removeMotion(item.id)}><Icon name="trash" size={15} /></button>
              </li>
            {/each}
          </ul>
        </Panel>
      {/if}

      {#if library.policies.length}
        <Panel title="Policies" icon="cpu" flush>
          <ul class="list">
            {#each library.policies as item (item.id)}
              <li class="row">
                <span class="rmark"><Icon name="cpu" size={17} /></span>
                <span class="rbody">
                  <span class="rname">{item.name}</span>
                  <span class="rmeta mono">{robotName(item.robot)} · {fmtSize(item.sizeKb)}</span>
                </span>
                <StatusPill tone="gold" dot={false}>{robotName(item.robot)}</StatusPill>
                <Button variant="secondary" size="sm" icon="play" onclick={() => library.openPolicyPreview(item.id)}>Preview</Button>
                <button class="del" aria-label={`Remove ${item.name}`} title="Remove" onclick={() => library.removePolicy(item.id)}><Icon name="trash" size={15} /></button>
              </li>
            {/each}
          </ul>
        </Panel>
      {/if}
    </div>
  {/if}
{/if}

<!-- Motion → play on connected robots -->
{#if playFor}
  <div class="overlay">
    <button class="backdrop" aria-label="Cancel" onclick={() => (playFor = null)}></button>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Play motion on robots">
      <h2>Play “{playFor.name}” on</h2>
      {#if robot.onlineRobots.length === 0}
        <p class="dlg-sub">No robots are connected. Connect one from the <a href="/robot">Robot console</a> first.</p>
      {:else}
        <p class="dlg-sub">Select the connected robots to play this motion on.</p>
        <ul class="play-list">
          {#each robot.onlineRobots as r (r.id)}
            <li>
              <button class="play-row" class:on={playSelected.includes(r.id)} onclick={() => togglePlayRobot(r.id)}>
                <span class="pr-check">{#if playSelected.includes(r.id)}<Icon name="check" size={13} />{/if}</span>
                <span class="pr-body">
                  <span class="pr-name">{r.name}</span>
                  <span class="pr-meta mono">{robot.modelName(r)} · {r.ip}</span>
                </span>
                <span class="pr-dot"></span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="dlg-actions">
        <Button variant="ghost" onclick={() => (playFor = null)}>Cancel</Button>
        {#if robot.onlineRobots.length}
          <Button variant="primary" icon="play" disabled={playSelected.length === 0} onclick={confirmPlay}>
            Play on {playSelected.length}
          </Button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Live playback session popup -->
{#if session}
  <div class="overlay">
    <div class="session" role="dialog" aria-modal="true" aria-label="Motion playback">
      <header class="s-head">
        <span class="s-title"><Icon name="play" size={15} /> Playing <strong>{session.motionName}</strong></span>
        <div class="s-robots">
          {#each session.robotIds as id (id)}
            <span class="s-chip">{robot.robots.find((r) => r.id === id)?.name ?? id}</span>
          {/each}
        </div>
        <button class="s-x" aria-label="Stop &amp; close" title="Stop &amp; close" onclick={() => library.stopPlaySession()}>
          <Icon name="x" size={16} />
        </button>
      </header>

      <div class="s-body">
        {#if session.state === "loading"}
          <div class="loading-pane fill"><Spinner size={22} /> Starting playback…</div>
        {:else if session.state === "error"}
          <div class="loading-pane fill err"><Icon name="alert" size={20} /> Couldn't start playback.</div>
        {:else}
          <StreamView
            fill
            title="Playback · Meshcat"
            url={session.url}
            name={session.motionName}
            stopLabel="Stop playback"
            onStop={() => library.stopPlaySession()}
          />
        {/if}
      </div>

      <footer class="s-controls">
        <div class="s-streams">
          {#each session.robotIds as id (id)}
            {@const st = session.status[id]}
            <div class="s-stream">
              <span class="s-rname">{robot.robots.find((r) => r.id === id)?.name ?? id}</span>
              <span class="s-phase {st?.phase ?? 'starting'}">{phaseLabel(st?.phase)}</span>
              {#if st && st.frames > 0}
                <span class="s-frame mono">{st.frame} / {st.frames}</span>
                <span class="s-bar">
                  <span
                    class="s-bar-fill"
                    style="width:{Math.min(100, (st.frame / st.frames) * 100)}%"
                  ></span>
                </span>
                {#if st.speed !== 1}<span class="s-spd mono">{st.speed}×</span>{/if}
              {:else if st?.message}
                <span class="s-msg" title={st.message}>{st.message}</span>
              {/if}
            </div>
          {/each}
        </div>
        <div class="s-actions">
          <Button
            variant={session.loop ? "primary" : "ghost"}
            size="sm"
            icon="refresh"
            onclick={() => library.toggleLoop()}
          >
            Loop {session.loop ? "on" : "off"}
          </Button>
          <Button
            variant={session.paused ? "primary" : "secondary"}
            size="sm"
            icon={session.paused ? "play" : "pause"}
            disabled={session.state !== "ready"}
            onclick={() => library.togglePauseSession()}
          >
            {session.paused ? "Play" : "Pause"}
          </Button>
          <Button variant="danger" size="sm" icon="power" onclick={() => library.stopPlaySession()}>Stop</Button>
        </div>
      </footer>
    </div>
  </div>
{/if}

<!-- Policy → pick target robot -->
{#if pendingPolicy}
  <div class="overlay">
    <button class="backdrop" aria-label="Cancel" onclick={() => (pendingPolicy = null)}></button>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Choose robot for policy">
      <h2>Which robot is this policy for?</h2>
      <p class="dlg-sub">Choose the model <strong>{pendingPolicy.name}</strong> was trained for. It determines the embodiment Isaac Lab loads for the rollout.</p>
      <div class="choices">
        {#each ROBOT_TYPES as t (t.id)}
          <button class="choice" class:soon={t.comingSoon} disabled={t.comingSoon} onclick={() => choosePolicyRobot(t.id)}>
            <span class="choice-icon"><Icon name="robot" size={22} /></span>
            <span class="choice-name">{t.name}</span>
            <span class="choice-vendor">{t.comingSoon ? "Coming soon" : t.vendor}</span>
          </button>
        {/each}
      </div>
      <div class="dlg-actions">
        <Button variant="ghost" onclick={() => (pendingPolicy = null)}>Cancel</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* segmented control (model toggle + speed) */
  .seg { display: inline-flex; gap: 2px; padding: 2px; background: var(--bg-elev-2); border: 1px solid var(--border-strong); border-radius: var(--r-md); }
  .seg-btn { font-family: var(--font-mono); font-weight: 600; letter-spacing: 0.04em; font-size: 11px; padding: 6px 11px; background: transparent; border: none; border-radius: var(--r-sm); color: var(--text-secondary); transition: all var(--transition); }
  .seg-btn:hover { color: var(--text-primary); }
  .seg-btn.active { background: var(--gold-tint); color: var(--gold-bright); }
  .seg-btn:disabled { opacity: 0.4; cursor: default; }
  .seg-btn:disabled:hover { color: var(--text-secondary); }

  .meta-row { display: flex; gap: 9px; margin-bottom: 16px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-secondary); padding: 5px 11px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--bg-elev-2); }
  .chip :global(svg) { color: var(--gold); }

  /* preview fills the content area's vertical space */
  .preview { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .loading-pane { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 340px; border: 1px dashed var(--border-strong); border-radius: var(--r-md); background: var(--bg-base); font-family: var(--font-mono); font-size: 13px; color: var(--text-secondary); }
  .loading-pane.fill { flex: 1; }
  .loading-pane.err { color: var(--red-bright); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
  .loading-pane.err :global(svg) { color: var(--red-bright); }

  /* transport */
  .transport { display: flex; align-items: center; gap: 14px; margin-top: 14px; padding: 12px 16px; background: var(--bg-elev-1); border: 1px solid var(--border); border-radius: var(--r-md); }
  .play { display: grid; place-items: center; width: 38px; height: 38px; flex: none; background: var(--gold); color: #1a1405; border: none; border-radius: 50%; transition: all var(--transition); }
  .play:hover { background: var(--gold-bright); box-shadow: 0 0 16px var(--gold-glow); }
  .time { font-size: 12px; color: var(--text-secondary); flex: none; min-width: 34px; }
  .scrub { flex: 1; -webkit-appearance: none; appearance: none; height: 5px; border-radius: var(--r-pill); background: var(--bg-elev-3); padding: 0; border: none; }
  .scrub::-webkit-slider-thumb { -webkit-appearance: none; width: 15px; height: 15px; border-radius: 50%; background: var(--gold); cursor: pointer; box-shadow: 0 0 8px var(--gold-glow); }
  .scrub::-moz-range-thumb { width: 15px; height: 15px; border: none; border-radius: 50%; background: var(--gold); cursor: pointer; }

  .import-error { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; padding: 11px 13px; border-radius: var(--r-md); background: var(--red-tint); border: 1px solid color-mix(in srgb, var(--red) 45%, transparent); color: var(--red-bright); font-size: 13px; }

  /* dropzone */
  .dropzone { width: 100%; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 9px; padding: 52px 24px; background: var(--bg-elev-1); border: 1px dashed var(--border-strong); border-radius: var(--r-lg); color: var(--text-secondary); }
  .dz-icon { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 4px; border-radius: var(--r-lg); background: var(--gold-tint); color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent); }
  .dz-title { font-size: 17px; font-weight: 650; color: var(--text-primary); }
  .dz-sub { font-size: 13px; max-width: 48ch; }
  .dz-sub code { font-family: var(--font-mono); color: var(--gold); }
  .dz-actions { display: flex; gap: 10px; margin-top: 10px; }

  /* lists */
  .stack { display: flex; flex-direction: column; gap: 18px; }
  .list { list-style: none; display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: 13px; padding: 13px 16px; border-top: 1px solid var(--border-soft); }
  .row:first-child { border-top: none; }
  .rmark { display: grid; place-items: center; width: 38px; height: 38px; flex: none; border-radius: var(--r-md); background: var(--bg-elev-2); border: 1px solid var(--border-strong); color: var(--text-secondary); }
  .rbody { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin-right: auto; }
  .rname { font-weight: 600; font-size: 13.5px; }
  .rmeta { font-size: 11.5px; color: var(--text-muted); }
  .del { display: grid; place-items: center; width: 30px; height: 30px; flex: none; background: transparent; border: 1px solid transparent; border-radius: var(--r-sm); color: var(--text-faint); transition: all var(--transition); }
  .del:hover { color: var(--red-bright); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-tint); }

  /* policy robot-choice modal */
  .overlay { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 24px; }
  .backdrop { position: absolute; inset: 0; background: rgba(4, 6, 10, 0.66); backdrop-filter: blur(2px); border: none; cursor: default; }
  .dialog { position: relative; width: 100%; max-width: 440px; background: var(--bg-elev-1); border: 1px solid var(--border-strong); border-radius: var(--r-lg); box-shadow: var(--shadow-2); padding: 22px; }
  .dialog h2 { font-size: 16px; margin-bottom: 8px; }
  .dlg-sub { color: var(--text-secondary); font-size: 13px; line-height: 1.55; }
  .dlg-sub strong { color: var(--text-primary); }
  .choices { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 18px 0 4px; }
  .choice { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 16px; background: var(--bg-elev-2); border: 1px solid var(--border-strong); border-radius: var(--r-md); text-align: left; transition: all var(--transition); }
  .choice.soon { opacity: 0.5; cursor: default; }
  .choice.soon:hover { border-color: var(--border-strong); background: var(--bg-elev-2); }
  .choice:hover { border-color: var(--gold); background: var(--gold-tint); }
  .choice-icon { color: var(--gold); margin-bottom: 4px; }
  .choice-name { font-weight: 650; font-size: 14px; color: var(--text-primary); }
  .choice-vendor { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
  .dlg-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }

  /* play-on-robots picker */
  .play-list { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 16px 0 4px; max-height: 320px; overflow-y: auto; }
  .play-row { width: 100%; display: flex; align-items: center; gap: 11px; padding: 11px 13px; background: var(--bg-elev-2); border: 1px solid var(--border-strong); border-radius: var(--r-md); color: var(--text-secondary); transition: all var(--transition); }
  .play-row:hover { border-color: var(--gold); color: var(--text-primary); }
  .play-row.on { border-color: var(--gold); background: var(--gold-tint); color: var(--text-primary); }
  .pr-check { display: grid; place-items: center; width: 20px; height: 20px; flex: none; border-radius: var(--r-sm); border: 1px solid var(--border-strong); color: #1a1405; }
  .play-row.on .pr-check { background: var(--gold); border-color: var(--gold); }
  .pr-body { display: flex; flex-direction: column; gap: 1px; margin-right: auto; text-align: left; min-width: 0; }
  .pr-name { font-weight: 600; font-size: 13px; }
  .pr-meta { font-size: 11px; color: var(--text-muted); }
  .pr-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }

  /* live playback session popup */
  .session { position: relative; width: min(1040px, 94vw); height: min(86vh, 820px); display: flex; flex-direction: column; background: var(--bg-elev-1); border: 1px solid var(--border-strong); border-radius: var(--r-lg); box-shadow: var(--shadow-2); overflow: hidden; }
  .s-head { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--border-soft); }
  .s-title { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-secondary); white-space: nowrap; }
  .s-title strong { color: var(--text-primary); }
  .s-title :global(svg) { color: var(--green); }
  .s-robots { display: flex; gap: 6px; flex-wrap: wrap; margin-right: auto; }
  .s-chip { font-family: var(--font-mono); font-size: 11px; color: var(--green); background: var(--green-tint); border: 1px solid color-mix(in srgb, var(--green) 40%, transparent); border-radius: var(--r-pill); padding: 3px 9px; }
  .s-x { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-elev-2); color: var(--text-secondary); transition: all var(--transition); }
  .s-x:hover { color: var(--red-bright); border-color: var(--red); background: var(--red-tint); }
  .s-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px; }
  .s-controls { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border-top: 1px solid var(--border-soft); flex-wrap: wrap; }
  .s-streams { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
  .s-stream { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .s-rname { font-weight: 650; font-size: 12px; color: var(--text-primary); white-space: nowrap; }
  .s-phase { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 8px; border-radius: var(--r-pill); color: var(--text-muted); background: var(--bg-elev-2); border: 1px solid var(--border-soft); white-space: nowrap; }
  .s-phase.playing { color: var(--green); background: var(--green-tint); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .s-phase.ramping, .s-phase.connecting, .s-phase.starting { color: var(--gold); background: color-mix(in srgb, var(--gold) 12%, transparent); border-color: color-mix(in srgb, var(--gold) 40%, transparent); }
  .s-phase.error { color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
  .s-frame { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
  .s-bar { flex: 1; min-width: 60px; max-width: 220px; height: 4px; background: var(--bg-elev-2); border-radius: var(--r-pill); overflow: hidden; }
  .s-bar-fill { display: block; height: 100%; background: var(--gold); transition: width 0.1s linear; }
  .s-spd { font-size: 11px; color: var(--text-muted); }
  .s-msg { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-actions { display: flex; gap: 8px; flex-shrink: 0; }
</style>
