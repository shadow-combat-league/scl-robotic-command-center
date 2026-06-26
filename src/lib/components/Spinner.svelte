<script lang="ts">
  interface Props {
    size?: number;
  }
  let { size = 16 }: Props = $props();
</script>

<span class="spinner" style="width:{size}px;height:{size}px" aria-label="Working"></span>

<style>
  .spinner {
    display: inline-block;
    border: 2px solid var(--border-strong);
    border-top-color: var(--gold);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
