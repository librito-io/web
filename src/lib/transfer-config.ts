// Shared transfer config — imported by both server (`$lib/server/transfer.ts`)
// and browser (`src/routes/app/transfer/+page.svelte`). Server-only modules
// under `$lib/server/` cannot be imported into client code, so the constant
// must live here to keep server and browser caps in lock-step.

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB
export const MAX_FILE_SIZE_LABEL = "10 MB";
