<script lang="ts">
  let { href, label } = $props<{ href: string; label: string }>();
</script>

<a class="breadcrumb" {href}>← {label}</a>

<style>
  .breadcrumb {
    display: inline-block;
    color: #888;
    font-size: 0.95rem;
    text-decoration: none;
    padding: 8px 0 16px;
  }
  .breadcrumb:hover {
    color: #ccc;
  }
</style>
