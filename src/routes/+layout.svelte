<script lang="ts">
  import "../app.css";
  import type { Snippet } from "svelte";
  import { page } from "$app/stores";
  import TopBar from "$lib/components/TopBar.svelte";
  import Dock from "$lib/components/Dock.svelte";
  import { robot } from "$lib/services/robot.svelte";

  let { children }: { children: Snippet } = $props();

  // Load persisted profiles before first paint so the shell reflects whether
  // any robots exist (the dock appears only once the first robot is added).
  robot.load();

  $effect(() => {
    robot.startTelemetry();
  });

  // The command dock shows only once a robot exists, and never on the focused
  // onboarding screen (/setup is reached via an "Add Robot" button, not the nav).
  let showDock = $derived(robot.hasRobots && !$page.url.pathname.startsWith("/setup"));
</script>

<div class="app">
  <TopBar />
  <main class="content" class:has-dock={showDock}>
    {@render children()}
  </main>
  {#if showDock}
    <Dock />
  {/if}
</div>

<style>
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 28px;
  }
  /* clear the floating dock so nothing hides behind it */
  .content.has-dock {
    padding-bottom: 96px;
  }
</style>
