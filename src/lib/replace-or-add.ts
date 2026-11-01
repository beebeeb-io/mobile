/**
 * Task SF-0001 (mobile#259 review M9): "Overwrite" uploads under the listed
 * file's id, which the upload now sends to the server explicitly (L13: a client
 * proposes every id). A member who may only ADD to a shared folder is refused
 * that id with 403 (server uploads.rs: an explicit `file_id` without Edit
 * permission), where the old name match quietly made a new file (task 2250).
 * Keep that outcome: on that init refusal (`UploadInitRefusedError`), the
 * same bytes go up as a NEW file under a freshly minted id. Nothing was sealed
 * or sent under the listed id yet.
 */
import { UploadInitRefusedError } from './api';

export async function replaceOrAdd<T>(params: {
  existingId: string;
  mint: () => Promise<string>;
  upload: (target: { fileId: string; replacing: boolean }) => Promise<T>;
}): Promise<T> {
  try {
    return await params.upload({ fileId: params.existingId, replacing: true });
  } catch (err) {
    // mobile#259 round 3: only the FIRST init's plain `forbidden` (nothing was
    // sealed or sent yet). A typed 403 (billing_read_only, account_frozen, …)
    // or one after chunks went up is the user's answer, never a second upload.
    if (!(err instanceof UploadInitRefusedError)) throw err;
    return params.upload({ fileId: await params.mint(), replacing: false });
  }
}

/**
 * `replaceOrAdd` when the user chose to overwrite `existingId`, a plain upload
 * under `fileId` otherwise. `run` gets the id to upload under and whether it is
 * the replace (only then may the listed row's name bytes be reused).
 */
export function uploadReplacingOrAdding<T>(
  existingId: string | undefined,
  fileId: string,
  mint: () => Promise<string>,
  run: (fileId: string, replacing: boolean) => Promise<T>,
): Promise<T> {
  if (!existingId) return run(fileId, false);
  return replaceOrAdd({ existingId, mint, upload: (target) => run(target.fileId, target.replacing) });
}
