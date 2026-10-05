/**
 * The real ports for the native signup (task 1746): `api.ts` for the server calls
 * and the beebeeb-crypto native module (UniFFI, `beebeeb_core::onboarding`) for the
 * ceremony. Kept out of the pure modules so those need no native mocks.
 */

import {
  fetchBreachRange,
  signupEmailStart,
  signupEmailVerify,
  signupRegisterFinish,
  signupRegisterStart,
} from '../api';
import { beginSignupUnlock, endSignupUnlock } from '../signup-unlock-guard';
import { createBreachCheck, createSignupCeremony, evaluatePasswordPolicy } from '../../../modules/beebeeb-crypto';
import { toActionError, type SignupPorts } from './ports';

export function createSignupPorts(adoptVault: SignupPorts['adoptVault']): SignupPorts {
  return {
    actions: {
      async emailStart(email, pilotKey) {
        try {
          await signupEmailStart(email, pilotKey || undefined);
        } catch (err) {
          throw toActionError(err, 'email_start_failed');
        }
      },
      async emailVerify(email, code) {
        try {
          return await signupEmailVerify(email, code);
        } catch (err) {
          throw toActionError(err, 'wrong_code');
        }
      },
      async registerStart(input) {
        try {
          return await signupRegisterStart({
            email: input.email,
            ticket: input.ticket,
            clientMessage: input.clientMessage,
            pilotKey: input.pilotKey || undefined,
          });
        } catch (err) {
          throw toActionError(err, 'register_start_failed');
        }
      },
      async registerFinish(input) {
        // register-finish stores the session token BEFORE the vault adopts the new
        // key. App.tsx polls for a token on every navigation event and would flip
        // `user` (remounting CryptoProvider) mid-write, purging the key signup just
        // created (task 1594 round 6). The bracket is closed by SignupScreen once
        // auth is refreshed, or here when the call fails (no token was stored).
        beginSignupUnlock();
        try {
          const r = await signupRegisterFinish({
            email: input.email,
            ticket: input.ticket,
            termsVersion: input.termsVersion,
            upload: input.upload,
            x25519Public: input.x25519Public,
            recoveryCheck: input.recoveryCheck,
            pilotKey: input.pilotKey || undefined,
          });
          return { userId: r.userId };
        } catch (err) {
          endSignupUnlock();
          throw toActionError(err, 'register_finish_failed');
        }
      },
    },
    ceremony: {
      create: createSignupCeremony,
      breach: createBreachCheck,
      evaluate: evaluatePasswordPolicy,
    },
    fetchBreachBody: fetchBreachRange,
    adoptVault,
  };
}
