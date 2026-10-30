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

export class ServerChangedItemIdError extends Error {
  readonly code = 'server_changed_item_id'

  constructor() {
    super(SERVER_CHANGED_ITEM_ID_MESSAGE)
    this.name = 'ServerChangedItemIdError'
  }
}

/**
 * Compares the id this client chose with the id an init/create/completion
 * answer echoed. Throws before any caller can adopt, seal or rename under the
 * echoed id.
 */
export function assertEchoedItemId(
  chosenId: string,
  echoedId: string | null | undefined,
): void {
  if (echoedId !== chosenId) throw new ServerChangedItemIdError()
}

export function isServerChangedItemIdError(err: unknown): err is ServerChangedItemIdError {
  return err instanceof ServerChangedItemIdError
}
