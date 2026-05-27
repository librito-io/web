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
<main style="padding:1rem;">{@render children()}</main>
