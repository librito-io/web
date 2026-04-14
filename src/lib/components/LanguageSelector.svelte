<script lang="ts">
  import { locale, _ } from "$lib/i18n";

  const LANGUAGES = [{ code: "en", label: "English" }];
</script>

<label class="wrap">
  <span class="label">{$_("menu.language")}</span>
  <select bind:value={$locale}>
    {#each LANGUAGES as lang (lang.code)}
      <option value={lang.code}>{lang.label}</option>
    {/each}
  </select>
</label>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  select {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    color: var(--text-primary);
  }
</style>
