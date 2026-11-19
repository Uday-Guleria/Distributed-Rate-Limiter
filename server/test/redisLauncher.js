import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Starts a throwaway Redis that a test is allowed to kill, so the chaos test works on any machine:
 *   - 'binary': a local `redis-server` on the PATH (Linux, macOS, WSL, CI)
 *   - 'docker': a disposable container from the same redis:7 image docker-compose uses (Windows)
 * detectRedisLauncher() returns null when neither is usable, and the test is skipped with a reason.
 */
const works = (cmd, args) => {
  try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 15_000 }).status === 0; } catch { return false; }
};

export function detectRedisLauncher() {
  if (works('redis-server', ['--version'])) return 'binary';
  // `docker version` exits non-zero when the CLI exists but the daemon (Docker Desktop) is not running.
  if (works('docker', ['version', '--format', '{{.Server.Version}}'])) return 'docker';
  return null;
}

const REDIS_ARGS = ['--save', '', '--appendonly', 'no'];

/** Returns { stop() }. stop() is a hard kill (SIGKILL / docker rm -f): the point is to simulate a crash. */
export function launchRedis(kind, port) {
  if (kind === 'binary') {
    const proc = spawn('redis-server', ['--port', String(port), ...REDIS_ARGS], { stdio: 'ignore' });
    return { stop: () => { proc.kill('SIGKILL'); } };
  }
  const name = `rl-chaos-${randomUUID().slice(0, 8)}`;
  const run = spawnSync(
    'docker',
    ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:6379`, 'redis:7', 'redis-server', ...REDIS_ARGS],
    { encoding: 'utf8', timeout: 180_000 }, // first run may have to pull the image
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr || run.error}`);
  return { stop: () => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 }); } };
}
