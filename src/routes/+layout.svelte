<script lang="ts">
  import "../app.css";
  import type { Snippet } from "svelte";
  import { page } from "$app/stores";
  import TopBar from "$lib/components/TopBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import { robot } from "$lib/services/robot.svelte";

  let { children }: { children: Snippet } = $props();

  // Load persisted profiles before first paint so the shell reflects whether
  // any robots exist (sidebar appears only once the first robot is added).
  robot.load();

  $effect(() => {
    robot.startTelemetry();
  });

  // Sidebar shows only once a robot exists, and never on the focused onboarding
  // screen (/setup is reached via an "Add Robot" button, not the nav).
  let showSidebar = $derived(robot.hasRobots && !$page.url.pathname.startsWith("/setup"));
</script>

<div class="app">
  <TopBar />
  <div class="body">
    {#if showSidebar}
      <Sidebar />
    {/if}
    <main class="content">
      {@render children()}
    </main>
  </div>
</div>

<style>
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 24px 28px;
  }
</style>
