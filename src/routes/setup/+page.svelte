<script lang="ts">
  import { onMount } from "svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Button from "$lib/components/Button.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import Field from "$lib/components/Field.svelte";
  import Spinner from "$lib/components/Spinner.svelte";
  import Stepper from "$lib/components/Stepper.svelte";
  import StatusPill from "$lib/components/StatusPill.svelte";
  import { robot } from "$lib/services/robot.svelte";
  import { ROBOT_TYPES, robotTypeSpec } from "$lib/services/robotTypes";
  import { onboarding as flow, WIZARD_STEPS } from "$lib/services/onboarding.svelte";

  // Each visit starts a fresh wizard. Nothing is saved until the final step,
  // so abandoning onboarding leaves no profile behind.
  onMount(() => {
    robot.load();
    flow.reset();
  });

  function barsFor(signal: number): number {
    return signal > 66 ? 3 : signal > 33 ? 2 : 1;
  }

  let typeNote = $derived(flow.type ? robotTypeSpec(flow.type).note : undefined);
</script>

<PageHeader
  eyebrow="Onboarding"
  title="Onboard a Robot"
  subtitle="A guided setup that takes a robot from powered-on to network-connected and motion-ready."
/>

<div class="wizard">
  <aside class="rail">
    <Stepper steps={WIZARD_STEPS} currentId={flow.step} />
  </aside>

  <div class="stage">
    <!-- ============================ STEP 1: PROFILE ============================ -->
    {#if flow.step === "profile"}
      <Panel title="Create Robot Profile" icon="robot">
        <div class="form">
          <Field label="Robot name" hint="A friendly name you'll recognize in the console.">
            <input type="text" placeholder="e.g. ATLAS-01" bind:value={flow.name} />
          </Field>

          <div class="field">
            <span class="label">Robot type</span>
            <div class="types">
              {#each ROBOT_TYPES as t (t.id)}
                <button
                  class="type-card"
                  class:selected={flow.type === t.id}
                  class:soon={t.comingSoon}
                  disabled={t.comingSoon}
                  onclick={() => flow.chooseType(t.id)}
                >
                  <span class="type-icon"><Icon name="robot" size={22} /></span>
                  <span class="type-name">{t.name}</span>
                  <span class="type-vendor">{t.vendor}</span>
                  {#if t.comingSoon}
                    <span class="type-soon">Coming soon</span>
                  {:else if flow.type === t.id}
                    <span class="type-check"><Icon name="check" size={13} /></span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        </div>

        <footer class="actions">
          <Button variant="ghost" href="/">Cancel</Button>
          <Button
            variant="primary"
            icon="chevronRight"
            disabled={!flow.name.trim() || !flow.type}
            onclick={() => flow.confirmProfile()}
          >
            Continue
          </Button>
        </footer>
      </Panel>

    <!-- ============================ STEP 2: ETHERNET ============================ -->
    {:else if flow.step === "ethernet"}
      <Panel title="Find Robot on Ethernet" icon="network">
        <p class="lead">
          Connect <strong>{flow.name}</strong> to this computer with an Ethernet cable, then scan
          for it at its wired address.
        </p>

        <div class="form">
          <Field label="Wired IP address" hint={typeNote}>
            <input type="text" spellcheck="false" bind:value={flow.ethernetIp} />
          </Field>
        </div>

        {#if flow.ethPhase === "working"}
          <div class="result working"><Spinner /> Scanning {flow.ethernetIp}…</div>
        {:else if flow.ethPhase === "ok"}
          <div class="result ok"><Icon name="check" size={16} /> {flow.ethMsg}</div>
        {:else if flow.ethPhase === "error"}
          <div class="result error"><Icon name="alert" size={16} /> {flow.ethMsg}</div>
        {/if}

        <footer class="actions">
          <Button variant="ghost" icon="arrowLeft" onclick={() => (flow.step = "profile")}>Back</Button>
          <div class="spacer"></div>
          <Button
            variant={flow.ethPhase === "ok" ? "secondary" : "primary"}
            icon="signal"
            disabled={flow.ethPhase === "working"}
            onclick={() => flow.scanEthernet()}
          >
            {flow.ethPhase === "ok" ? "Re-scan" : "Scan"}
          </Button>
          {#if flow.ethPhase === "ok"}
            <Button variant="primary" icon="chevronRight" onclick={() => (flow.step = "ssh")}>
              Continue
            </Button>
          {/if}
        </footer>
      </Panel>

    <!-- ============================ STEP 3: SSH ============================ -->
    {:else if flow.step === "ssh"}
      <Panel title="Authenticate over SSH" icon="lock">
        <p class="lead">
          Enter the SSH password for the robot's onboard computer. This lets the command center
          configure the network for you.
        </p>

        <div class="form two">
          <Field label="SSH user">
            <input type="text" spellcheck="false" bind:value={flow.sshUser} />
          </Field>
          <Field label="SSH password">
            <input type="password" placeholder="••••••••" bind:value={flow.sshPassword} />
          </Field>
        </div>

        {#if flow.sshPhase === "working"}
          <div class="result working"><Spinner /> Connecting to {flow.sshUser}@{flow.ethernetIp}…</div>
        {:else if flow.sshPhase === "ok"}
          <div class="result ok"><Icon name="check" size={16} /> {flow.sshMsg}</div>
        {:else if flow.sshPhase === "error"}
          <div class="result error"><Icon name="alert" size={16} /> {flow.sshMsg}</div>
        {/if}

        <footer class="actions">
          <Button variant="ghost" icon="arrowLeft" onclick={() => (flow.step = "ethernet")}>Back</Button>
          <div class="spacer"></div>
          <Button
            variant={flow.sshPhase === "ok" ? "secondary" : "primary"}
            icon="lock"
            disabled={flow.sshPhase === "working"}
            onclick={() => flow.authenticateSsh()}
          >
            {flow.sshPhase === "ok" ? "Re-authenticate" : "Authenticate"}
          </Button>
          {#if flow.sshPhase === "ok"}
            <Button variant="primary" icon="chevronRight" onclick={() => (flow.step = "wifi")}>
              Continue
            </Button>
          {/if}
        </footer>
      </Panel>

    <!-- ============================ STEP 4: WI-FI ============================ -->
    {:else if flow.step === "wifi"}
      <Panel title="Connect Robot to Wi-Fi" icon="wifi">
        {#if flow.wifiMode === null}
          <p class="lead">Choose how the robot should join a wireless network.</p>
          <div class="wifi-modes">
            <button class="mode-card" onclick={() => flow.chooseWifiMode("computer")}>
              <span class="mode-icon"><Icon name="monitor" size={22} /></span>
              <span class="mode-title">Use this computer's network</span>
              <span class="mode-desc">Join <strong>{flow.computerSsid}</strong>, the network this computer is on.</span>
            </button>
            <button class="mode-card" onclick={() => flow.chooseWifiMode("scan")}>
              <span class="mode-icon"><Icon name="wifi" size={22} /></span>
              <span class="mode-title">Scan robot's networks</span>
              <span class="mode-desc">List Wi-Fi networks the robot can see and pick one to join.</span>
            </button>
          </div>

        {:else}
          <div class="wifi-head">
            <StatusPill tone="cyan" dot={false}>
              {flow.wifiMode === "computer" ? "Computer's network" : "Robot scan"}
            </StatusPill>
            <button class="link-btn" onclick={() => flow.backToWifiChoice()}>Change option</button>
          </div>

          {#if flow.wifiMode === "scan"}
            {#if flow.wifiScanPhase === "idle"}
              <div class="scan-cta">
                <Button variant="primary" icon="wifi" onclick={() => flow.scanWifi()}>Scan Networks</Button>
              </div>
            {:else if flow.wifiScanPhase === "working"}
              <div class="result working"><Spinner /> Asking robot for nearby networks…</div>
            {:else}
              <ul class="wifi-list">
                {#each flow.wifiList as net (net.ssid)}
                  <li>
                    <button
                      class="wifi-row"
                      class:selected={flow.selectedSsid === net.ssid}
                      onclick={() => flow.selectWifi(net.ssid)}
                    >
                      <Icon name="wifi" size={16} />
                      <span class="wifi-ssid">{net.ssid}</span>
                      {#if net.secured}<Icon name="lock" size={13} class="wifi-lock" />{/if}
                      <span class="bars">
                        {#each [1, 2, 3] as b (b)}
                          <span class="bar" class:on={b <= barsFor(net.signal)}></span>
                        {/each}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
              <button class="link-btn rescan" onclick={() => flow.scanWifi()}>Re-scan</button>
            {/if}
          {/if}

          <!-- selected network → password + connect -->
          {#if flow.targetSsid}
            <div class="selected-net">
              <Icon name="wifi" size={16} />
              <span class="mono">{flow.targetSsid}</span>
            </div>
            <div class="form">
              <Field label="Wi-Fi password" hint="The password the robot will use to join this network.">
                <input type="password" placeholder="••••••••" bind:value={flow.wifiPassword} />
              </Field>
            </div>
          {/if}

          {#if flow.wifiPhase === "working"}
            <div class="result working"><Spinner /> Joining {flow.targetSsid}…</div>
          {:else if flow.wifiPhase === "ok"}
            <div class="result ok">
              <Icon name="check" size={16} /> {flow.wifiMsg} · new address <strong class="mono">{flow.newIp}</strong>
            </div>
          {:else if flow.wifiPhase === "error"}
            <div class="result error"><Icon name="alert" size={16} /> {flow.wifiMsg}</div>
          {/if}
        {/if}

        <footer class="actions">
          <Button variant="ghost" icon="arrowLeft" onclick={() => (flow.step = "ssh")}>Back</Button>
          <div class="spacer"></div>
          {#if flow.wifiMode !== null && flow.targetSsid && flow.wifiPhase !== "ok"}
            <Button
              variant="primary"
              icon="wifi"
              disabled={flow.wifiPhase === "working"}
              onclick={() => flow.connectWifi()}
            >
              Connect
            </Button>
          {/if}
          {#if flow.wifiPhase === "ok"}
            <Button variant="primary" icon="check" onclick={() => flow.finish()}>Finish & Save</Button>
          {/if}
        </footer>
      </Panel>

    <!-- ============================ STEP 5: DONE ============================ -->
    {:else if flow.step === "done"}
      <Panel title="Setup Complete" icon="check">
        <div class="done">
          <span class="done-icon"><Icon name="check" size={34} /></span>
          <h2>{flow.name} is ready</h2>
          <p>The robot is onboarded and its new address has been saved to the local database.</p>

          <dl class="summary">
            <div><dt>Robot</dt><dd>{flow.name}</dd></div>
            <div><dt>Type</dt><dd>{flow.type ? robotTypeSpec(flow.type).name : "—"}</dd></div>
            <div><dt>Wi-Fi</dt><dd>{flow.targetSsid ?? "—"}</dd></div>
            <div><dt>Address</dt><dd class="mono">{flow.newIp}</dd></div>
          </dl>

          <div class="done-actions">
            <Button variant="ghost" icon="plus" onclick={() => flow.reset()}>Add Another</Button>
            <Button variant="primary" icon="robot" href="/robot">Go to Console</Button>
          </div>
        </div>
      </Panel>
    {/if}
  </div>
</div>

<style>
  .wizard {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 22px;
    align-items: start;
  }
  .rail {
    position: sticky;
    top: 0;
    padding: 8px 4px;
  }
  .stage {
    max-width: 640px;
  }

  .lead {
    color: var(--text-secondary);
    font-size: 13.5px;
    margin-bottom: 18px;
  }
  .lead strong { color: var(--text-primary); }

  .form { display: flex; flex-direction: column; gap: 16px; }
  .form.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .field { display: flex; flex-direction: column; gap: 8px; }

  /* type selection */
  .types { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .type-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 16px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    text-align: left;
    transition: all var(--transition);
  }
  .type-card:hover { border-color: var(--gold); }
  .type-card.selected {
    border-color: var(--gold);
    background: var(--gold-tint);
    box-shadow: 0 0 0 3px var(--gold-tint);
  }
  .type-icon { color: var(--gold); margin-bottom: 4px; }
  .type-name { font-weight: 650; font-size: 14px; color: var(--text-primary); }
  .type-vendor { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
  .type-check {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--gold);
    color: #1a1405;
  }
  .type-card.soon {
    opacity: 0.5;
    cursor: default;
  }
  .type-card.soon:hover {
    border-color: var(--border-strong);
  }
  .type-soon {
    position: absolute;
    top: 12px;
    right: 12px;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--gold);
    background: var(--gold-tint);
    border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent);
    padding: 3px 7px;
    border-radius: var(--r-pill);
  }

  /* result banners */
  .result {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding: 11px 13px;
    border-radius: var(--r-md);
    font-size: 13px;
    font-family: var(--font-mono);
    border: 1px solid;
  }
  .result strong { font-weight: 700; }
  .result.working { color: var(--text-secondary); background: var(--bg-elev-2); border-color: var(--border-strong); }
  .result.ok { color: var(--green-bright); background: var(--green-tint); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
  .result.error { color: var(--red-bright); background: var(--red-tint); border-color: color-mix(in srgb, var(--red) 45%, transparent); }

  /* footer actions */
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid var(--border-soft);
  }
  .spacer { flex: 1; }

  /* wi-fi modes */
  .wifi-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .mode-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 7px;
    padding: 18px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    text-align: left;
    transition: all var(--transition);
  }
  .mode-card:hover { border-color: var(--gold); background: var(--bg-elev-3); transform: translateY(-2px); }
  .mode-icon {
    display: grid; place-items: center;
    width: 40px; height: 40px;
    border-radius: var(--r-md);
    background: var(--gold-tint); color: var(--gold);
    border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent);
  }
  .mode-title { font-weight: 650; font-size: 13.5px; color: var(--text-primary); }
  .mode-desc { font-size: 12px; color: var(--text-muted); }
  .mode-desc strong { color: var(--text-secondary); }

  .wifi-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .link-btn {
    background: none; border: none; padding: 0;
    font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.06em;
    color: var(--cyan);
  }
  .link-btn:hover { color: var(--cyan-bright); }
  .rescan { margin-top: 12px; }

  .scan-cta { display: flex; justify-content: center; padding: 12px 0; }

  /* wi-fi list */
  .wifi-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .wifi-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 11px 13px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .wifi-row:hover { border-color: var(--gold); color: var(--text-primary); }
  .wifi-row.selected { border-color: var(--gold); background: var(--gold-tint); color: var(--text-primary); }
  .wifi-ssid { font-family: var(--font-mono); font-size: 13px; margin-right: auto; }
  .wifi-row :global(.wifi-lock) { color: var(--text-muted); }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 14px; }
  .bar { width: 3px; background: var(--border-strong); border-radius: 1px; }
  .bar:nth-child(1) { height: 5px; }
  .bar:nth-child(2) { height: 9px; }
  .bar:nth-child(3) { height: 13px; }
  .bar.on { background: var(--green); }

  .selected-net {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 16px 0 12px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--cyan-tint);
    border: 1px solid color-mix(in srgb, var(--cyan) 35%, transparent);
    color: var(--cyan-bright);
    font-size: 13px;
  }

  /* done */
  .done { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 13px; padding: 12px 8px; }
  .done-icon {
    display: grid; place-items: center;
    width: 66px; height: 66px;
    border-radius: 50%;
    background: var(--green-tint); color: var(--green-bright);
    border: 1px solid color-mix(in srgb, var(--green) 50%, transparent);
    box-shadow: 0 0 24px var(--green-glow);
  }
  .done h2 { font-size: 21px; }
  .done > p { color: var(--text-secondary); font-size: 13.5px; max-width: 44ch; }
  .summary {
    width: 100%;
    max-width: 360px;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
  }
  .summary div {
    display: flex;
    justify-content: space-between;
    padding: 10px 4px;
    border-top: 1px solid var(--border-soft);
    font-size: 13px;
  }
  .summary div:first-child { border-top: none; }
  .summary dt { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); }
  .summary dd { color: var(--text-primary); font-weight: 600; }
  .done-actions { display: flex; gap: 10px; margin-top: 8px; }

  @media (max-width: 860px) {
    .wizard { grid-template-columns: 1fr; }
    .rail { position: static; }
    .types, .form.two, .wifi-modes { grid-template-columns: 1fr; }
  }
</style>
