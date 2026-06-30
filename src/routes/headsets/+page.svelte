<script lang="ts">
  import { onMount } from "svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Button from "$lib/components/Button.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import Spinner from "$lib/components/Spinner.svelte";
  import StatusPill from "$lib/components/StatusPill.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { headsets, type Headset } from "$lib/services/headsets.svelte";

  let confirmForget = $state<string | null>(null);
  let pct = $derived(
    headsets.scanProgress.total
      ? Math.round((headsets.scanProgress.done / headsets.scanProgress.total) * 100)
      : 0,
  );

  onMount(() => {
    headsets.refreshPcIp();
  });

  function tone(h: Headset): "green" | "gold" | "cyan" | "red" | "muted" {
    switch (h.status) {
      case "paired":
        return "green";
      case "streaming":
        return "cyan";
      case "pairing":
      case "discovered":
        return "gold";
      case "error":
        return "red";
      default:
        return "muted";
    }
  }
  function label(h: Headset): string {
    switch (h.status) {
      case "paired":
        return "Paired";
      case "streaming":
        return "Streaming";
      case "pairing":
        return "Pairing…";
      case "discovered":
        return "Discovered";
      case "error":
        return "Error";
      default:
        return "Offline";
    }
  }
</script>

<PageHeader
  eyebrow="Teleoperation"
  title="Headsets"
  subtitle="Discover XRoboToolkit headsets on your Wi-Fi and pair them to this computer — once paired, the headset connects back automatically."
>
  {#snippet actions()}
    <span class="pcip mono"><Icon name="network" size={13} /> This PC · {headsets.pcIp || "—"}</span>
    <Button
      variant="primary"
      size="sm"
      icon="refresh"
      disabled={headsets.scanning}
      onclick={() => headsets.discover()}
    >
      {headsets.scanning ? "Scanning…" : "Scan Wi-Fi"}
    </Button>
  {/snippet}
</PageHeader>

{#if headsets.scanning}
  <div class="scan">
    <Spinner size={14} />
    <span class="mono"
      >Probing {headsets.scanProgress.done} / {headsets.scanProgress.total} hosts…</span
    >
    <span class="bar"><span class="bar-fill" style="width:{pct}%"></span></span>
  </div>
{/if}

{#if headsets.error}
  <p class="err"><Icon name="alert" size={15} /> {headsets.error}</p>
{/if}

<Panel title="Headsets" icon="headset">
  {#snippet actions()}
    <span class="counts mono">{headsets.onlineCount} online · {headsets.pairedCount} paired</span>
  {/snippet}

  {#if headsets.headsets.length === 0}
    <div class="empty">
      <Icon name="headset" size={30} />
      <p class="empty-t">No headsets yet</p>
      <p class="empty-s">
        Put the headset on the same Wi-Fi and enable XRoboToolkit discovery, then
        <strong>Scan Wi-Fi</strong>.
      </p>
    </div>
  {:else}
    <ul class="hlist">
      {#each headsets.headsets as h (h.id)}
        <li class="hrow" class:off={!h.online}>
          <span class="hicon"><Icon name="headset" size={22} /></span>
          <div class="hmeta">
            <span class="hname">{h.name}</span>
            <span class="hsub mono"
              >{h.model} · {h.ip || "—"}{h.battery != null ? ` · ${h.battery}%` : ""}</span
            >
            {#if h.error}<span class="herr">{h.error}</span>{/if}
          </div>
          <StatusPill tone={tone(h)} pulse={h.status === "pairing"}>{label(h)}</StatusPill>
          <div class="hactions">
            {#if h.status === "paired" || h.status === "streaming"}
              <Button variant="secondary" size="sm" onclick={() => headsets.unpair(h.id)}>
                Unpair
              </Button>
            {:else}
              <Button
                variant="primary"
                size="sm"
                icon="plug"
                disabled={!h.online || h.status === "pairing"}
                onclick={() => headsets.pair(h.id)}
              >
                Pair
              </Button>
            {/if}
            <Button variant="ghost" size="sm" icon="trash" onclick={() => (confirmForget = h.id)}>
              Forget
            </Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<Panel title="How discovery works" icon="network">
  <ol class="how">
    <li>The headset runs <strong>XRoboToolkit</strong> and serves <code>GET /xrobo/info</code> on port <code>{8090}</code> with its id, model and status.</li>
    <li><strong>Scan Wi-Fi</strong> probes every address on this computer's subnet for that endpoint and lists the headsets that answer.</li>
    <li><strong>Pair</strong> POSTs this computer's IP to <code>/xrobo/pair</code>; the headset stores it and connects back for teleop — no input needed on the headset.</li>
  </ol>
</Panel>

{#if confirmForget}
  <ConfirmDialog
    title="Forget headset?"
    message="It will be removed from the list. You can rediscover it with another scan."
    confirmLabel="Forget"
    danger
    onConfirm={() => {
      if (confirmForget) headsets.forget(confirmForget);
      confirmForget = null;
    }}
    onClose={() => (confirmForget = null)}
  />
{/if}

<style>
  .pcip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
    padding: 4px 10px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-pill);
  }
  .scan {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .scan .bar {
    flex: 1;
    max-width: 320px;
    height: 4px;
    background: var(--bg-elev-2);
    border-radius: var(--r-pill);
    overflow: hidden;
  }
  .scan .bar-fill {
    display: block;
    height: 100%;
    background: var(--gold);
    transition: width 0.15s linear;
  }
  .err {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
  }
  .counts {
    font-size: 11px;
    color: var(--text-muted);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 6px;
    padding: 36px 16px;
    color: var(--text-muted);
  }
  .empty-t {
    font-weight: 650;
    color: var(--text-secondary);
  }
  .empty-s {
    font-size: 13px;
    max-width: 380px;
  }

  .hlist {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hrow {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
  }
  .hrow.off {
    opacity: 0.6;
  }
  .hicon {
    color: var(--gold);
    flex: none;
  }
  .hmeta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .hname {
    font-weight: 650;
    color: var(--text-primary);
  }
  .hsub {
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .herr {
    font-size: 11.5px;
    color: var(--red);
  }
  .hactions {
    display: flex;
    gap: 8px;
    flex: none;
  }

  .how {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .how code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--gold);
    background: var(--bg-elev-2);
    padding: 1px 5px;
    border-radius: var(--r-sm);
  }
</style>
