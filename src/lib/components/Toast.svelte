<script lang="ts">
  let { visible = $bindable<boolean>(false), message = "" } = $props<{
    visible: boolean;
    message: string;
  }>();

  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (!visible) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      visible = false;
    }, 5000);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });
</script>

<div class="toast" class:visible>{message}</div>
