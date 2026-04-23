<script lang="ts">
  interface Transfer {
    id: string;
    filename: string;
    fileSize: number;
    status: "pending" | "downloaded" | "expired" | "failed";
    uploadedAt: string;
    downloadedAt: string | null;
  }

  interface UploadState {
    id: string;
    file: File;
    status: "validating" | "initiating" | "uploading" | "done" | "error";
    progress: number;
    error: string | null;
    transferId: string | null;
  }

  let { data } = $props();
  let transfers = $state<Transfer[]>(data.transfers);
  let uploads = $state<UploadState[]>([]);
  let dragOver = $state(false);
  let cancellingIds = $state<Set<string>>(new Set());

  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(id);
  });

  const PENDING_TTL_MS = 48 * 3600 * 1000;
  function hoursRemaining(uploadedAt: string): number {
    const expiresAt = new Date(uploadedAt).getTime() + PENDING_TTL_MS;
    return Math.max(0, Math.floor((expiresAt - now) / 3600000));
  }

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

  function uploadToSignedUrl(
    url: string,
    fileData: ArrayBuffer,
    onProgress: (pct: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable)
          onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed: ${xhr.status}`));
      });
      xhr.addEventListener("error", () => reject(new Error("Upload failed")));
      xhr.open("PUT", url);
      xhr.send(new Uint8Array(fileData));
    });
  }

  async function hashFileSha256(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function processFile(file: File) {
    const uploadId = crypto.randomUUID();
    const upload: UploadState = {
      id: uploadId,
      file,
      status: "validating",
      progress: 0,
      error: null,
      transferId: null,
    };
    uploads = [...uploads, upload];

    function updateUpload(patch: Partial<UploadState>) {
      uploads = uploads.map((u) =>
        u.id === uploadId ? { ...u, ...patch } : u,
      );
    }

    if (!file.name.toLowerCase().endsWith(".epub")) {
      updateUpload({ status: "error", error: "Only EPUB files are accepted" });
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      updateUpload({ status: "error", error: "File exceeds 20MB limit" });
      return;
    }

    const isDuplicate = transfers.some(
      (t) => t.filename === file.name && t.status === "pending",
    );
    if (isDuplicate) {
      updateUpload({ status: "error", error: "This file is already pending" });
      return;
    }

    try {
      updateUpload({ status: "validating" });
      const sha256 = await hashFileSha256(file);

      updateUpload({ status: "initiating" });
      const initiateRes = await fetchWithSafariRetry("/api/transfer/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          fileSize: file.size,
          sha256,
        }),
      });

      if (initiateRes.status === 429) {
        updateUpload({
          status: "error",
          error: "Too many uploads, try again in a moment",
        });
        return;
      }
      if (!initiateRes.ok) {
        const body = await initiateRes.json().catch(() => ({}));
        updateUpload({
          status: "error",
          error: body.message || "Upload failed",
        });
        return;
      }

      const { transferId, uploadUrl } = await initiateRes.json();
      updateUpload({ transferId });

      const fileData = await file.arrayBuffer();

      updateUpload({ status: "uploading" });
      await uploadToSignedUrl(uploadUrl, fileData, (pct) => {
        updateUpload({ progress: pct });
      });

      updateUpload({ status: "done", progress: 100 });
      await refreshTransfers();
    } catch (err) {
      updateUpload({
        status: "error",
        error: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  async function fetchWithSafariRetry(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(input, init);
    } catch {
      // Safari/WebKit reuses idle HTTP keep-alive sockets the server already
      // closed; first request fails mid-flight with "Load failed" / "network
      // connection was lost". Retry once on a fresh connection.
      return await fetch(input, init);
    }
  }

  async function refreshTransfers() {
    try {
      const res = await fetchWithSafariRetry("/api/transfer/list");
      if (res.ok) {
        const body = await res.json();
        transfers = body.transfers;
      }
    } catch {
      // Swallow: stale list is fine, next action will refresh.
    }
  }

  async function handleCancel(transferId: string) {
    if (cancellingIds.has(transferId)) return;
    cancellingIds = new Set(cancellingIds).add(transferId);
    try {
      const res = await fetchWithSafariRetry(`/api/transfer/${transferId}`, {
        method: "DELETE",
      });
      // Treat 404 as success: row already gone, UI and server now agree.
      if (res.ok || res.status === 404) {
        await refreshTransfers();
      }
    } catch {
      // Swallow network error; user can retry.
    } finally {
      const next = new Set(cancellingIds);
      next.delete(transferId);
      cancellingIds = next;
    }
  }

  function handleFileInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) {
      Array.from(input.files).forEach(processFile);
      input.value = "";
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const files = e.dataTransfer?.files;
    if (files) Array.from(files).forEach(processFile);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function retryUpload(upload: UploadState) {
    uploads = uploads.filter((u) => u.id !== upload.id);
    processFile(upload.file);
  }

  function dismissUpload(upload: UploadState) {
    uploads = uploads.filter((u) => u.id !== upload.id);
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const statusBadge: Record<
    Transfer["status"],
    { label: string; color: string; bg: string }
  > = {
    pending: { label: "Queued", color: "#92400e", bg: "#fef3c7" },
    downloaded: { label: "Downloaded", color: "#065f46", bg: "#d1fae5" },
    expired: { label: "Expired", color: "#6b7280", bg: "#f3f4f6" },
    failed: { label: "Failed", color: "#991b1b", bg: "#fee2e2" },
  };

  const activeUploads = $derived(uploads.filter((u) => u.status !== "done"));
  const hasContent = $derived(transfers.length > 0 || activeUploads.length > 0);
</script>

<div class="content">
  <h1>Transfer Books</h1>

  <section>
    <h2>Upload EPUBs</h2>

    <!-- Drop zone -->
    <div
      class="drop-zone"
      class:drag-over={dragOver}
      ondrop={handleDrop}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      role="region"
      aria-label="File upload drop zone"
    >
      <p>Drag &amp; drop EPUB files here, or</p>
      <label class="file-label">
        Choose Files
        <input
          type="file"
          multiple
          accept=".epub"
          onchange={handleFileInput}
          style="display: none;"
        />
      </label>
      <p class="drop-hint">EPUB only &middot; max 20 MB per file</p>
    </div>
  </section>

  <!-- Active uploads -->
  {#if activeUploads.length > 0}
    <section>
      <h2>Uploading</h2>
      <ul class="upload-list">
        {#each activeUploads as upload (upload.id)}
          <li class="upload-item">
            <div class="upload-header">
              <span class="filename">{upload.file.name}</span>
              <span class="filesize">{formatBytes(upload.file.size)}</span>
            </div>

            {#if upload.status === "error"}
              <p class="upload-error">{upload.error}</p>
              <div class="upload-actions">
                <button class="btn-small" onclick={() => retryUpload(upload)}
                  >Retry</button
                >
                <button
                  class="btn-small btn-ghost"
                  onclick={() => dismissUpload(upload)}>Dismiss</button
                >
              </div>
            {:else}
              <div class="progress-bar-track">
                <div
                  class="progress-bar-fill"
                  style="width: {upload.progress}%"
                ></div>
              </div>
              <p class="upload-status-label">
                {#if upload.status === "validating"}
                  Validating...
                {:else if upload.status === "initiating"}
                  Preparing...
                {:else if upload.status === "uploading"}
                  Uploading... {upload.progress}%
                {/if}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- Transfer history -->
  <section>
    <h2>Queued</h2>

    {#if !hasContent}
      <p class="empty-state">
        Upload EPUBs here. They'll be delivered to your Librito on next sync.
      </p>
    {:else if transfers.length === 0}
      <p class="empty-state">No transfers yet.</p>
    {:else}
      <ul class="transfer-list">
        {#each transfers as transfer (transfer.id)}
          <li class="transfer-item">
            <div class="transfer-main">
              <span class="filename">{transfer.filename}</span>
              <span class="filesize">{formatBytes(transfer.fileSize)}</span>
              <span
                class="badge"
                style="color: {statusBadge[transfer.status]?.color ??
                  '#374151'}; background: {statusBadge[transfer.status]?.bg ??
                  '#f3f4f6'};"
              >
                {statusBadge[transfer.status]?.label ?? transfer.status}
              </span>
            </div>
            <div class="transfer-meta">
              <span>Added: {formatDate(transfer.uploadedAt)}</span>
              {#if transfer.status === "pending"}
                {@const hrs = hoursRemaining(transfer.uploadedAt)}
                <span
                  class="countdown"
                  class:urgent={hrs < 12}
                  class:critical={hrs < 2}
                >
                  {hrs > 0 ? `Expires in ${hrs}h` : "Expiring…"}
                </span>
              {/if}
              {#if transfer.downloadedAt}
                <span>Downloaded: {formatDate(transfer.downloadedAt)}</span>
              {/if}
            </div>
            {#if transfer.status === "pending"}
              <button
                class="btn-small btn-danger"
                disabled={cancellingIds.has(transfer.id)}
                onclick={() => handleCancel(transfer.id)}
              >
                {cancellingIds.has(transfer.id) ? "Removing..." : "Remove"}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .drop-zone {
    border: 2px dashed #d1d5db;
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
    transition:
      border-color 0.15s,
      background 0.15s;
    cursor: default;
  }

  .drop-zone.drag-over {
    border-color: #6366f1;
    background: #f5f3ff;
  }

  .drop-hint {
    font-size: 0.85rem;
    color: #9ca3af;
    margin-top: 0.5rem;
  }

  .file-label {
    display: inline-block;
    padding: 0.5rem 1.25rem;
    background: #6366f1;
    color: white;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.15s;
  }

  .file-label:hover {
    background: #4f46e5;
  }

  .upload-list,
  .transfer-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .upload-item,
  .transfer-item {
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.75rem 1rem;
  }

  .upload-header,
  .transfer-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .filename {
    font-weight: 500;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .filesize {
    font-size: 0.85rem;
    color: #6b7280;
    white-space: nowrap;
  }

  .badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    white-space: nowrap;
  }

  .transfer-meta {
    margin-top: 0.35rem;
    font-size: 0.8rem;
    color: #9ca3af;
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .progress-bar-track {
    margin-top: 0.5rem;
    height: 6px;
    background: #e5e7eb;
    border-radius: 9999px;
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: #6366f1;
    border-radius: 9999px;
    transition: width 0.2s ease;
  }

  .upload-status-label {
    margin-top: 0.3rem;
    font-size: 0.8rem;
    color: #6b7280;
  }

  .upload-error {
    margin-top: 0.4rem;
    font-size: 0.85rem;
    color: #dc2626;
  }

  .upload-actions {
    margin-top: 0.5rem;
    display: flex;
    gap: 0.5rem;
  }

  .btn-small {
    padding: 0.3rem 0.75rem;
    font-size: 0.8rem;
    border: 1px solid #d1d5db;
    border-radius: 5px;
    background: white;
    cursor: pointer;
    transition: background 0.1s;
  }

  .btn-small:hover {
    background: #f9fafb;
  }

  .btn-ghost {
    color: #6b7280;
  }

  .btn-danger {
    color: #dc2626;
    border-color: #fca5a5;
    margin-top: 0.5rem;
  }

  .btn-danger:hover {
    background: #fef2f2;
  }

  .empty-state {
    color: #6b7280;
    font-style: italic;
  }

  .countdown {
    color: #6b7280;
  }

  .countdown.urgent {
    color: #b45309;
  }

  .countdown.critical {
    color: #b91c1c;
    font-weight: 600;
  }
</style>
