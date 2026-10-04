import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';

// Shared across worker processes and state directories for this OS user.
// Lock by endpoint, not model name: models on one inference server share capacity.
export async function acquireEndpoint(config, signal, onCompromised) {
  const key = crypto.createHash('sha256').update(config.baseUrl).digest('hex');
  const target = path.join(config.endpointLockDir, key);
  while (true) {
    signal?.throwIfAborted();
    try {
      const release = await lockfile.lock(target, {
        realpath: false, retries: 0, stale: 30000, update: 5000, onCompromised,
      });
      if (signal?.aborted) { await release(); signal.throwIfAborted(); }
      return release;
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      await delay(150, undefined, { signal });
    }
  }
}
