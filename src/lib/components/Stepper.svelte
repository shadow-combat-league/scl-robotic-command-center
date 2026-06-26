<script lang="ts">
  import Icon from "./Icon.svelte";

  interface Step {
    id: string;
    label: string;
    hint: string;
  }
  interface Props {
    steps: Step[];
    currentId: string;
  }
  let { steps, currentId }: Props = $props();

  let currentIndex = $derived(steps.findIndex((s) => s.id === currentId));
  function status(i: number): "done" | "active" | "pending" {
    if (i < currentIndex) return "done";
    if (i === currentIndex) return "active";
    return "pending";
  }
</script>

<ol class="stepper">
  {#each steps as step, i (step.id)}
    <li class="st {status(i)}">
      <span class="rail">
        <span class="mark">
          {#if status(i) === "done"}<Icon name="check" size={13} />{:else}{i + 1}{/if}
        </span>
        {#if i < steps.length - 1}<span class="line"></span>{/if}
      </span>
      <span class="text">
        <span class="st-label">{step.label}</span>
        <span class="st-hint">{step.hint}</span>
      </span>
    </li>
  {/each}
</ol>

<style>
  .stepper {
    list-style: none;
    display: flex;
    flex-direction: column;
  }
  .st {
    display: flex;
    gap: 13px;
    min-height: 58px;
  }
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: none;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--border-strong);
    background: var(--bg-elev-2);
    color: var(--text-muted);
    transition: all var(--transition);
  }
  .line {
    flex: 1;
    width: 2px;
    background: var(--border);
    margin: 4px 0;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 4px;
  }
  .st-label {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .st-hint {
    font-size: 11.5px;
    color: var(--text-faint);
  }

  .st.done .mark {
    color: var(--green);
    border-color: color-mix(in srgb, var(--green) 50%, transparent);
    background: var(--green-tint);
  }
  .st.done .line {
    background: color-mix(in srgb, var(--green) 40%, transparent);
  }
  .st.active .mark {
    color: var(--gold);
    border-color: var(--gold);
    background: var(--gold-tint);
    box-shadow: 0 0 0 3px var(--gold-tint);
  }
  .st.active .st-label {
    color: var(--gold-bright);
  }
  .st.active .st-hint {
    color: var(--text-secondary);
  }
</style>
