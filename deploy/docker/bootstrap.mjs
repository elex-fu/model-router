import { createInterface } from 'node:readline';

if (!process.stdin.isTTY) {
  console.error('Run this helper interactively inside the container (docker compose exec -it).');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
async function ask(prompt, hidden = false) {
  const originalWrite = rl._writeToOutput;
  if (hidden) {
    rl._writeToOutput = () => {};
    process.stdout.write(prompt);
  } else process.stdout.write(prompt);
  try {
    return await new Promise((resolve, reject) => {
      const clean = () => { rl.off('line', line); rl.off('SIGINT', interrupt); rl.off('close', closed); };
      const line = (value) => { clean(); resolve(value); };
      const closed = () => { clean(); reject(new Error('Input cancelled')); };
      const interrupt = () => { rl.close(); };
      rl.once('line', line);
      rl.once('SIGINT', interrupt);
      rl.once('close', closed);
    });
  } finally {
    rl._writeToOutput = originalWrite;
    if (hidden) process.stdout.write('\n');
  }
}

try {
  const token = await ask('One-time bootstrap token: ', true);
  const name = await ask('Administrator name: ');
  const password = await ask('Administrator password: ', true);
  const response = await fetch('http://127.0.0.1:15006/admin/api/v1/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name, password }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? `Bootstrap failed (${response.status})`);
  console.log('Administrator created. Open the admin UI and sign in.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rl.close();
}
