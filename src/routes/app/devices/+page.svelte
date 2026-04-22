<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();

  let pairingCode = $state("");
  let claimError = $state("");
  let claimLoading = $state(false);
  let renamingId = $state<string | null>(null);

  async function handleClaim(e: SubmitEvent) {
    e.preventDefault();
    claimLoading = true;
    claimError = "";

    const doFetch = () =>
      fetch("/api/pair/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode.trim() }),
      });

    try {
      let res: Response;
      try {
        res = await doFetch();
      } catch {
        // Safari/WebKit reuses idle HTTP keep-alive sockets the server already
        // closed; first POST fails mid-flight with "network connection was lost".
        // Retry once on a fresh connection.
        res = await doFetch();
      }

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

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return "Never";
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
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
              use:enhance={({ formElement }) => {
                return async ({ result, update }) => {
                  // Safari/WebKit stale keep-alive: retry once on a fresh socket.
                  if (result.type === "error" && !formElement.dataset.retried) {
                    formElement.dataset.retried = "1";
                    formElement.requestSubmit();
                    return;
                  }
                  delete formElement.dataset.retried;
                  renamingId = null;
                  await update();
                };
              }}
            >
              <input type="hidden" name="deviceId" value={device.id} />
              <input
                type="text"
                name="name"
                value={device.name}
                required
                maxlength="50"
              />
              <button type="submit">Save</button>
              <button type="button" onclick={() => (renamingId = null)}
                >Cancel</button
              >
            </form>
          {:else}
            <strong>{device.name}</strong>
            <span>Last synced: {formatDate(device.last_synced_at)}</span>
            <span
              >Paired: {formatDate(device.paired_at ?? device.created_at)}</span
            >
            <button onclick={() => (renamingId = device.id)}>Rename</button>
            <form
              method="POST"
              action="?/revoke"
              use:enhance={({ formElement }) => {
                return async ({ result, update }) => {
                  // Safari/WebKit stale keep-alive: retry once on a fresh socket.
                  if (result.type === "error" && !formElement.dataset.retried) {
                    formElement.dataset.retried = "1";
                    formElement.requestSubmit();
                    return;
                  }
                  delete formElement.dataset.retried;
                  await update();
                };
              }}
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
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
