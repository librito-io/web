<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { onMount } from 'svelte';

  let { data, children } = $props();

  onMount(() => {
    const {
      data: { subscription }
    } = data.supabase.auth.onAuthStateChange((_, session) => {
      if (session?.expires_at !== data.session?.expires_at) {
        invalidate('supabase:auth');
      }
    });
    return () => subscription.unsubscribe();
  });
</script>

{@render children()}
