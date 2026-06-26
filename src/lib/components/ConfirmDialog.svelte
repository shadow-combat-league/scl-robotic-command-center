<script lang="ts">
  import Button from "./Button.svelte";

  interface Props {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onClose: () => void;
  }
  let {
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    onConfirm,
    onClose,
  }: Props = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay">
  <button class="backdrop" aria-label="Cancel" onclick={onClose}></button>
  <div class="dialog" role="dialog" aria-modal="true" aria-label={title}>
    <h2>{title}</h2>
    <p>{message}</p>
    <div class="actions">
      <Button variant="ghost" onclick={onClose}>{cancelLabel}</Button>
      <Button variant={danger ? "danger" : "primary"} onclick={onConfirm}>{confirmLabel}</Button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(4, 6, 10, 0.66);
    backdrop-filter: blur(2px);
    border: none;
    cursor: default;
  }
  .dialog {
    position: relative;
    width: 100%;
    max-width: 400px;
    background: var(--bg-elev-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2);
    padding: 22px;
    animation: pop 140ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  @keyframes pop {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }
  h2 {
    font-size: 16px;
    margin-bottom: 8px;
  }
  p {
    color: var(--text-secondary);
    font-size: 13.5px;
    line-height: 1.55;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }
</style>
