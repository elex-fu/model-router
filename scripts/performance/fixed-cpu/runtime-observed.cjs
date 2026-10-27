'use strict';
// Trusted diagnostic assembly only; no production source or timed-path hooks.
const { installBusinessObserver } = require('./startup-observer.cjs');
exports.createManagedSaasGatewayRuntime = async function (...args) {
  const observer = installBusinessObserver();
  try {
    const original = require('./runtime.cjs').createManagedSaasGatewayRuntime;
    const handle = await Reflect.apply(original, this, args);
    return observer.attachReadiness(handle);
  } catch (error) {
    observer.fail(error);
    throw error;
  }
};
