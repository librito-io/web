<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { _ } from "$lib/i18n";
  import { fetchWithSafariRetry, safariRetryEnhance } from "$lib/fetchRetry";
  import { formatDate } from "$lib/time/formatDate";

  let { data, form } = $props();

  let pairingCode = $state("");
  let claimError = $state("");
  let claimLoading = $state(false);
  let renamingId = $state<string | null>(null);
  // Tracks which device's last enhance submission exhausted its Safari
  // retry and surfaced a network-class error. `form` doesn't populate on
  // `result.type === "error"`, so a separate per-row flag is required to
  // render the fallback message in the right place.
  let networkErrorDeviceId = $state<string | null>(null);

  async function handleClaim(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    claimLoading = true;
    claimError = "";

    try {
      const res = await fetchWithSafariRetry("/app/api/pair/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode.trim() }),
      });

      const body = await res.json();

      if (!res.ok) {
        claimError = body.message || "Failed to claim code";
        return;
      }

      pairingCode = "";
      await invalidateAll();
    } catch {
      claimError = "Network error. Please try again.";
    } finally {
      claimLoading = false;
    }
  }
</script>

<h1>Devices</h1>

<section>
  <h2>Add Device</h2>
  <p>Enter the 6-digit code shown on your Librito device.</p>

  {#if claimError}
    <p style="color: red;">{claimError}</p>
  {/if}

  <form onsubmit={handleClaim}>
    <input
      type="text"
      bind:value={pairingCode}
      placeholder="000000"
      maxlength="6"
      inputmode="numeric"
      required
    />
    <button type="submit" disabled={claimLoading}>
      {claimLoading ? "Pairing..." : "Pair Device"}
    </button>
  </form>
</section>

<section>
  <h2>Paired Devices</h2>

  {#if data.devices.length === 0}
    <p>No devices paired yet.</p>
  {:else}
    <ul>
      {#each data.devices as device (device.id)}
        <li>
          {#if renamingId === device.id}
            <form
              method="POST"
              action="?/rename"
              use:enhance={safariRetryEnhance({
                onSuccess: () => {
                  renamingId = null;
                  networkErrorDeviceId = null;
                },
                onError: () => {
                  networkErrorDeviceId = device.id;
                },
              })}
            >
              <input type="hidden" name="deviceId" value={device.id} />
              <input
                type="text"
                name="name"
                value={device.name}
                required
                maxlength="50"
                aria-describedby="rename-{device.id}-hint"
              />
              <small id="rename-{device.id}-hint" style="display: block;"
                >Max 50 characters</small
              >
              <button type="submit">Save</button>
              <button type="button" onclick={() => (renamingId = null)}
                >Cancel</button
              >
              {#if form && "action" in form && form.action === "rename" && form.deviceId === device.id}
                <p style="color: red;">{form.error}</p>
              {/if}
              {#if networkErrorDeviceId === device.id}
                <p style="color: red;">Network error. Please try again.</p>
              {/if}
            </form>
          {:else}
            <strong>{device.name}</strong>
            <span
              >Last synced: {formatDate(
                device.last_synced_at,
                $_("never"),
              )}</span
            >
            <span
              >Paired: {formatDate(
                device.paired_at ?? device.created_at,
                $_("never"),
              )}</span
            >
            <button onclick={() => (renamingId = device.id)}>Rename</button>
            <form
              method="POST"
              action="?/unpair"
              use:enhance={safariRetryEnhance({
                onSuccess: () => {
                  networkErrorDeviceId = null;
                },
                onError: () => {
                  networkErrorDeviceId = device.id;
                },
              })}
              style="display: inline;"
            >
              <input type="hidden" name="deviceId" value={device.id} />
              <button
                type="submit"
                onclick={(e) => {
                  if (
                    !confirm(
                      "Unpair this device? It will need to be re-paired.",
                    )
                  )
                    e.preventDefault();
                }}>Unpair</button
              >
            </form>
            {#if form && "action" in form && form.action === "unpair" && form.deviceId === device.id}
              <p style="color: red;">{form.error}</p>
            {/if}
            {#if networkErrorDeviceId === device.id}
              <p style="color: red;">Network error. Please try again.</p>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
