<script lang="ts">
  /** SCL angular wordmark + product name, mirroring the BRAINDANCE lockup. */
  interface Props {
    subtitle?: string;
  }
  let { subtitle = "COMMAND CENTER" }: Props = $props();
</script>

<div class="logo">
  <svg class="mark" width="34" height="26" viewBox="0 0 34 26" aria-hidden="true">
    <!-- stylized angular S / C / L blocks -->
    <path
      d="M2 4 L13 4 L10 8 L6 8 L6 11 L11 11 L8 22 L0 22 L3 18 L7 18 L7 15 L2 15 Z"
      fill="var(--gold)"
    />
    <path d="M15 4 L25 4 L22 8 L18 8 L17 18 L21 18 L24 14 L21 22 L13 22 Z" fill="var(--gold)" />
    <path d="M27 4 L31 4 L29 18 L34 18 L33 22 L24 22 Z" fill="var(--gold)" />
  </svg>
  <div class="words">
    <span class="brand">SCL</span>
    <span class="sub">{subtitle}</span>
  </div>
</div>

<style>
  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    user-select: none;
  }
  .mark {
    filter: drop-shadow(0 0 8px var(--gold-glow));
    flex: none;
  }
  .words {
    display: flex;
    flex-direction: column;
    line-height: 1;
  }
  .brand {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 16px;
    letter-spacing: 0.06em;
    color: var(--text-primary);
  }
  .sub {
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.26em;
    color: var(--text-muted);
    margin-top: 3px;
  }
</style>
