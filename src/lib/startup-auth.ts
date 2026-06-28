export type StartupAuthState =
  | 'unknown'
  | 'no-token'
  | 'token-present'
  | 'token-read-timeout'
  | 'restored'
  | 'invalid-token';

export type StartupAuthUiDecision =
  | 'keep-restoring'
  | 'show-authenticated'
  | 'show-signed-out';

export function decideStartupAuthUi(state: StartupAuthState): StartupAuthUiDecision {
  switch (state) {
    case 'restored':
      return 'show-authenticated';
    case 'no-token':
    case 'invalid-token':
      return 'show-signed-out';
    case 'unknown':
    case 'token-present':
    case 'token-read-timeout':
      return 'keep-restoring';
  }
}

export function shouldKeepStartupRestoring(state: StartupAuthState): boolean {
  return decideStartupAuthUi(state) === 'keep-restoring';
}
