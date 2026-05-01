let mod: any = null;

try {
  const { requireNativeModule } = require('expo');
  mod = requireNativeModule('BeebeebCrypto');
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

export default mod as any;
