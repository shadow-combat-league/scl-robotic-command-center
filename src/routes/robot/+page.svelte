<script lang="ts">
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Button from "$lib/components/Button.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import RobotCard from "$lib/components/RobotCard.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { robot } from "$lib/services/robot.svelte";
  import type { RobotProfile } from "$lib/services/types";

  let focusedId = $state<string | null>(null);
  function toggle(id: string) {
    focusedId = focusedId === id ? null : id;
  }

  let pendingDelete = $state<RobotProfile | null>(null);
  function confirmDelete() {
    if (pendingDelete) robot.remove(pendingDelete.id);
    pendingDelete = null;
  }
</script>

<PageHeader
  eyebrow="Live"
  title="Robot Console"
  subtitle="Monitor and command every robot at once. Connect any number — operationally usually two."
>
  {#snippet actions()}
    <Button variant="primary" size="sm" icon="plus" href="/setup">Add Robot</Button>
    {#if robot.anyConnectable}
      <Button variant="secondary" size="sm" icon="plug" onclick={() => robot.connectAll()}>
        Connect All
      </Button>
    {/if}
    {#if robot.anyOnline}
      {#if robot.allEstopped}
        <Button variant="secondary" size="sm" icon="power" onclick={() => robot.releaseAll()}>
          Release All
        </Button>
      {:else}
        <Button variant="danger" size="sm" icon="power" onclick={() => robot.allStop()}>
          All-Stop
        </Button>
      {/if}
    {/if}
  {/snippet}
</PageHeader>

{#if !robot.hasRobots}
  <div class="empty">
    <span class="empty-icon"><Icon name="robot" size={30} /></span>
    <p>No robots yet. Onboard one to bring it online.</p>
    <Button variant="primary" icon="plus" href="/setup">Add Robot</Button>
  </div>
{:else}
  <div class="fleet-bar">
    <span class="count">
      <span class="num mono" class:live={robot.anyOnline}>{robot.onlineCount}</span>
      <span class="den mono">/ {robot.robots.length}</span>
      <span class="lbl label">Online</span>
    </span>
  </div>

  <div class="grid">
    {#each robot.robots as profile (profile.id)}
      <div class="cell" class:wide={focusedId === profile.id}>
        <RobotCard
          {profile}
          expanded={focusedId === profile.id}
          onToggle={() => toggle(profile.id)}
          onDelete={() => (pendingDelete = profile)}
        />
      </div>
    {/each}
  </div>
{/if}

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

<style>
  .fleet-bar {
    display: flex;
    align-items: center;
    margin-bottom: 16px;
  }
  .count {
    display: inline-flex;
    align-items: baseline;
    gap: 7px;
  }
  .num {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .num.live {
    color: var(--green);
  }
  .den {
    font-size: 16px;
    color: var(--text-muted);
  }
  .lbl {
    margin-left: 6px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
    align-items: start;
  }
  .cell.wide {
    grid-column: 1 / -1;
    max-width: 560px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 13px;
    padding: 56px 24px;
    background: var(--bg-elev-1);
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-lg);
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: var(--r-lg);
    background: var(--gold-tint);
    color: var(--gold);
    border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent);
  }
  .empty p {
    color: var(--text-secondary);
    font-size: 14px;
  }
</style>
