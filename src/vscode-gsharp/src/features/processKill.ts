// Kills the whole `dotnet test` process tree, not just the immediate `dotnet` process.
//
// `child.kill()` alone only terminates the `dotnet` launcher. On Windows, the actual
// `testhost.exe` (and any attached debuggee) is a separate process that survives,
// keeps the TRX/results directory open, and leaves the run un-cancelled. On POSIX,
// `dotnet` typically execs into the same process so a plain kill works, but a plain
// kill would still miss any child processes `dotnet` forked instead of exec'd into
// (e.g. when a debugger is attached), so the whole process group is targeted instead.
import * as cp from 'child_process';

export interface KillCommand {
  command: string;
  args: string[];
}

/** Pure selection logic: which OS-level command kills an entire process tree by pid.
 * Kept separate from `killProcessTree` so it can be unit-tested without spawning a
 * real process. */
export function getKillCommand(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): KillCommand {
  if (platform === 'win32') {
    return { command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  }

  // POSIX: killing the negative pid targets the whole process group. This requires
  // the child to have been spawned with `detached: true` (see runTestProcess /
  // runDebugProcess), which makes it its own process group leader.
  return { command: 'kill', args: ['-TERM', `-${pid}`] };
}

/**
 * Terminates `child` and everything it spawned. On Windows this shells out to
 * `taskkill /T /F`. On POSIX it sends SIGTERM to the process group, then escalates to
 * SIGKILL after a short grace period if the group hasn't exited.
 */
export function killProcessTree(
  child: cp.ChildProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (platform === 'win32') {
    const { command, args } = getKillCommand(pid, platform);
    cp.execFile(command, args, () => {
      // Best effort: the process may have already exited.
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process group already gone.
  }

  const killTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already exited after SIGTERM.
    }
  }, 2000);
  killTimer.unref();
}
