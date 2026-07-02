<script lang="ts">
  let { data, children } = $props();
</script>

<header style="padding:1rem; border-bottom:1px solid #ddd;">
  <strong>Catalog Admin</strong> · {data.adminUser.email ?? "(no email)"}
  <nav style="margin-left:1rem; display:inline;">
    <a href="/app/admin">Search</a>
    | <a href="/app/admin/fill-rate">Fill rate</a>
  </nav>
</header>
<!-- Not <main>: the root layout's .app-main is the sole page landmark (#586). -->
<div style="padding:1rem;">{@render children()}</div>
