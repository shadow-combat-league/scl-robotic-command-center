<script lang="ts">
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Button from "$lib/components/Button.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import Spinner from "$lib/components/Spinner.svelte";
  import StatusPill from "$lib/components/StatusPill.svelte";
  import StreamView from "$lib/components/StreamView.svelte";
  import { library } from "$lib/services/motions.svelte";
  import { ROBOT_TYPES } from "$lib/services/robotTypes";
  import type { RobotType } from "$lib/services/types";

  let motionInput: HTMLInputElement;
  let policyInput: HTMLInputElement;
  let pendingPolicyFile = $state<File | null>(null);

  async function onPickMotion(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await library.importMotionFromFile(file);
    input.value = "";
  }
  function onPickPolicy(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) pendingPolicyFile = file; // ask which robot first
    input.value = "";
  }
  function choosePolicyRobot(robot: RobotType) {
    if (pendingPolicyFile) library.importPolicy(pendingPolicyFile, robot);
    pendingPolicyFile = null;
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
  <PageHeader eyebrow="Motion Preview" title={mtn.name} subtitle="Live retarget preview, streamed from Meshcat.">
    {#snippet actions()}
      <div class="seg">
        {#each ROBOT_TYPES as t (t.id)}
          <button class="seg-btn" class:active={library.previewRobot === t.id} onclick={() => library.setModel(t.id)}>{t.name}</button>
        {/each}
      </div>
      <Button variant="ghost" size="sm" icon="arrowLeft" onclick={() => library.closePreview()}>Library</Button>
    {/snippet}
  </PageHeader>

  <div class="meta-row">
    <span class="chip mono"><Icon name="file" size={13} /> {mtn.frames} frames</span>
    <span class="chip mono">{fmtTime(mtn.durationSec)} @ {mtn.fps}fps</span>
    <span class="chip mono">{mtn.columns} DoF</span>
  </div>

  {#if library.previewState === "loading"}
    <div class="loading-pane"><Spinner size={22} /> Loading {robotName(library.previewRobot)} model & retargeting motion…</div>
  {:else if library.previewState === "ready"}
    <StreamView title="3D Motion Preview" url={library.previewUrl} name={mtn.name} stopLabel="Close preview" onStop={() => library.closePreview()} />
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

{:else if library.previewKind === "policy" && pol}
  <!-- ===================== POLICY PREVIEW (Isaac Lab) ===================== -->
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
    <div class="loading-pane"><Spinner size={22} /> Starting Isaac Lab & loading policy onto {robotName(pol.robot)}…</div>
  {:else if library.previewState === "ready"}
    <StreamView title="Isaac Lab · Policy Rollout" url={library.previewUrl} name={pol.name} stopLabel="Stop rollout" onStop={() => library.closePreview()} />
  {/if}

{:else}
  <!-- ===================== LIBRARY ===================== -->
  <PageHeader
    eyebrow="Library"
    title="Motions & Policies"
    subtitle="Import LAFAN1 motion datasets (.csv) to preview in Meshcat, or RL policies (.onnx) to roll out in Isaac Lab."
  >
    {#snippet actions()}
      <Button variant="secondary" icon="cpu" onclick={() => policyInput?.click()}>Import Policy</Button>
      <Button variant="primary" icon="import" onclick={() => motionInput?.click()}>Import Motion</Button>
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
        <Button variant="primary" icon="import" onclick={() => motionInput?.click()}>Import Motion</Button>
        <Button variant="secondary" icon="cpu" onclick={() => policyInput?.click()}>Import Policy</Button>
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
                <Button variant="secondary" size="sm" icon="play" onclick={() => library.openMotionPreview(item.id)}>Preview</Button>
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

<!-- Policy → pick target robot -->
{#if pendingPolicyFile}
  <div class="overlay">
    <button class="backdrop" aria-label="Cancel" onclick={() => (pendingPolicyFile = null)}></button>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Choose robot for policy">
      <h2>Which robot is this policy for?</h2>
      <p class="dlg-sub">Choose the model <strong>{pendingPolicyFile.name}</strong> was trained for. It determines the embodiment Isaac Lab loads for the rollout.</p>
      <div class="choices">
        {#each ROBOT_TYPES as t (t.id)}
          <button class="choice" onclick={() => choosePolicyRobot(t.id)}>
            <span class="choice-icon"><Icon name="robot" size={22} /></span>
            <span class="choice-name">{t.name}</span>
            <span class="choice-vendor">{t.vendor}</span>
          </button>
        {/each}
      </div>
      <div class="dlg-actions">
        <Button variant="ghost" onclick={() => (pendingPolicyFile = null)}>Cancel</Button>
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

  .meta-row { display: flex; gap: 9px; margin-bottom: 16px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-secondary); padding: 5px 11px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--bg-elev-2); }
  .chip :global(svg) { color: var(--gold); }

  .loading-pane { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 340px; border: 1px dashed var(--border-strong); border-radius: var(--r-md); background: var(--bg-base); font-family: var(--font-mono); font-size: 13px; color: var(--text-secondary); }

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
  .choice:hover { border-color: var(--gold); background: var(--gold-tint); }
  .choice-icon { color: var(--gold); margin-bottom: 4px; }
  .choice-name { font-weight: 650; font-size: 14px; color: var(--text-primary); }
  .choice-vendor { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
  .dlg-actions { display: flex; justify-content: flex-end; margin-top: 14px; }
</style>
