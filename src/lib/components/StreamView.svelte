<script lang="ts">
  import Icon from "./Icon.svelte";
  import Spinner from "./Spinner.svelte";

  interface Props {
    /** Web URL of the embedded viewport (Meshcat static page, Isaac Lab WebRTC client…). */
    url: string;
    name: string;
    /** Toolbar title, e.g. "3D Motion Preview" or "Isaac Lab · Policy Rollout". */
    title?: string;
    onStop: () => void;
    stopLabel?: string;
    /** Stretch to fill the parent (e.g. fullscreen) instead of a fixed height. */
    fill?: boolean;
  }
  let { url, name, title = "3D View", onStop, stopLabel = "Stop", fill = false }: Props = $props();

  let loading = $state(true);
  let reloadKey = $state(0);

  function reload() {
    loading = true;
    reloadKey++;
  }
</script>

<div class="viewer" class:fill>
  <header class="vbar">
    <span class="vtitle"><Icon name="cube" size={14} /> {title}</span>
    <span class="vurl mono">{url}</span>
    <div class="vactions">
      <button class="vbtn" title="Reload viewer" aria-label="Reload viewer" onclick={reload}>
        <Icon name="refresh" size={14} />
      </button>
      <a class="vbtn" title="Open in browser" aria-label="Open in browser" href={url} target="_blank" rel="noreferrer">
        <Icon name="external" size={14} />
      </a>
      <button class="vbtn stop" title={stopLabel} aria-label={stopLabel} onclick={onStop}>
        <Icon name="power" size={14} />
      </button>
    </div>
  </header>

  <div class="stage">
    {#if loading}
      <div class="loading"><Spinner size={20} /> Connecting…</div>
    {/if}
    {#key reloadKey}
      <iframe class="frame" src={url} title={`${name} — ${title}`} onload={() => (loading = false)}></iframe>
    {/key}
  </div>
</div>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-base);
  }
  .vbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 11px;
    background: var(--bg-elev-1);
    border-bottom: 1px solid var(--border-soft);
  }
  .vtitle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .vtitle :global(svg) { color: var(--gold); }
  .vurl {
    font-size: 10.5px;
    color: var(--text-faint);
    margin-right: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vactions { display: flex; gap: 6px; flex: none; }
  .vbtn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .vbtn:hover { color: var(--gold-bright); border-color: var(--gold); }
  .vbtn.stop:hover { color: var(--red-bright); border-color: var(--red); background: var(--red-tint); }

  .stage {
    position: relative;
    height: 340px;
    background: radial-gradient(120% 100% at 50% 0%, #0d1320, #06080d 80%);
  }
  .viewer.fill {
    height: 100%;
    flex: 1;
    min-height: 0;
  }
  .viewer.fill .stage {
    flex: 1;
    height: auto;
  }
  .frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
    display: block;
  }
  .loading {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 11px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-secondary);
    background: var(--bg-base);
  }
</style>
