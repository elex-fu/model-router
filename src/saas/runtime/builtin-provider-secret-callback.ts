import { CodexNativeWsSessionError } from '../gateway/codex/native-ws-session.js';

/** Callback failures may contain credential material; only the fixed native-session error vocabulary may escape. */
export async function consumeBuiltinProviderSecret<T>(secret: Uint8Array, use: (secret: Uint8Array) => Promise<T>): Promise<T> {
  try { return await use(secret); }
  catch (error) {
    if (error instanceof CodexNativeWsSessionError) throw error;
    throw new Error('Built-in provider credential is unavailable');
  } finally { secret.fill(0); }
}
