import { createServer } from 'node:net';

export async function unusedLoopbackPorts(): Promise<{ server: number; admin: number }> {
  const server = createServer();
  const admin = createServer();
  const listeners = [server, admin];

  try {
    for (const listener of listeners) {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
      });
    }

    const serverAddress = server.address();
    const adminAddress = admin.address();
    if (!serverAddress || typeof serverAddress === 'string' || !adminAddress || typeof adminAddress === 'string') {
      throw new Error('Unable to allocate loopback ports for CLI tests');
    }

    return { server: serverAddress.port, admin: adminAddress.port };
  } finally {
    await Promise.all(
      listeners.map(
        (listener) =>
          new Promise<void>((resolve) => {
            if (!listener.listening) {
              resolve();
              return;
            }
            listener.close(() => resolve());
          }),
      ),
    );
  }
}
