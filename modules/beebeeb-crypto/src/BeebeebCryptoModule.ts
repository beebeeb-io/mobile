/**
 * Bridge to the BeebeebCrypto native module.
 *
 * In an Expo dev client / production build this resolves to the real native
 * module wired through Expo Modules (Swift on iOS, Kotlin on Android). In
 * Expo Go (or any environment where the module is not linked) it falls back
 * to a Proxy stub whose every method throws — callers MUST guard with
 * try/catch and either fall back to a non-crypto path or surface a clear
 * "native build required" message to the user. Never silently substitute
 * fake crypto output.
 */

let mod: any = null;
let nativeAvailable = false;

try {
  const { requireNativeModule } = require('expo');
  mod = requireNativeModule('BeebeebCrypto');
  nativeAvailable = true;
} catch {
  mod = new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'string') {
        return (..._args: any[]) => {
          throw new Error(`BeebeebCrypto native module not available — cannot call ${prop}`);
        };
      }
      return undefined;
    },
  });
}

/**
 * True when the real native module is linked. False in Expo Go or any
 * environment using the Proxy stub. Use this to short-circuit calls and
 * fall back to plain (non-E2E) auth/preview paths instead of catching
 * the throw from the stub.
 */
export const isNativeAvailable: boolean = nativeAvailable;

export default mod as any;
