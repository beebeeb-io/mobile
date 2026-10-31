/**
 * Task SF-0001 (contract 2275 L13): the client mints an item id and proposes
 * it; the server must echo that same id back. Task 2275: a create whose
 * answer names a different item is aborted BEFORE anything is sealed,
 * renamed, published or used as a destination — the ids this client already
 * encrypted under are the only ones its bytes may live under.
 *
 * Mirrors the web client's module (web #206) so both clients speak the same
 * typed error and the same plain sentence to the user.
 */
export const SERVER_CHANGED_ITEM_ID_MESSAGE =
  'The server answered with a different item. Nothing was uploaded under it.'

/**
 * mobile#259 review M6: after the server finished the upload "nothing was
 * uploaded" is not true. The bytes went up under our id, but the answer named
 * another item, so the upload is not counted (or listed) as done.
 */
export const SERVER_CHANGED_ITEM_ID_AFTER_COMPLETE_MESSAGE =
  'The server finished this upload under a different item. Beebeeb did not count it as uploaded.'

/** Where the answer came from: an init/create, or a completion. */
export type ItemIdEchoStage = 'create' | 'completion'

export class ServerChangedItemIdError extends Error {
  readonly code = 'server_changed_item_id'
  readonly stage: ItemIdEchoStage

  constructor(stage: ItemIdEchoStage = 'create') {
    super(stage === 'completion' ? SERVER_CHANGED_ITEM_ID_AFTER_COMPLETE_MESSAGE : SERVER_CHANGED_ITEM_ID_MESSAGE)
    this.name = 'ServerChangedItemIdError'
    this.stage = stage
  }
}

/**
 * Compares the id this client chose with the id an init/create/completion
 * answer echoed (byte equality: a differently-cased id is another id). Throws
 * before any caller can adopt, seal or rename under the echoed id.
 */
export function assertEchoedItemId(
  chosenId: string,
  echoedId: string | null | undefined,
  stage: ItemIdEchoStage = 'create',
): void {
  if (echoedId !== chosenId) throw new ServerChangedItemIdError(stage)
}

export function isServerChangedItemIdError(err: unknown): err is ServerChangedItemIdError {
  return err instanceof ServerChangedItemIdError
}
