import * as vscode from 'vscode';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Logger } from './logger';

/**
 * The major version of the .NET runtime the bundled GSharp language server targets
 * (see build/gsharp.build.props NetCoreAppTargetFramework = net10.0). The server cannot
 * be hosted by an older runtime, so we locate (and, if necessary, acquire) a compatible
 * runtime before launching it and degrade gracefully when none can be obtained.
 */
export const REQUIRED_DOTNET_MAJOR_VERSION = 10;

/** The `major.minor` string passed to the .NET Install Tool when locating/acquiring a runtime. */
export const REQUIRED_DOTNET_VERSION = `${REQUIRED_DOTNET_MAJOR_VERSION}.0`;

/** Download page shown to the user when no compatible runtime can be found or acquired. */
export const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download/dotnet/10.0';

/** Extension id of the .NET Install Tool we depend on to find/acquire runtimes. */
const DOTNET_INSTALL_TOOL_EXTENSION_ID = 'ms-dotnettools.vscode-dotnet-runtime';

/** The id we present to the .NET Install Tool as the requesting extension. */
const REQUESTING_EXTENSION_ID = 'gsharp.vscode-gsharp';

// Minimal subset of the .NET Install Tool's API surface that we use.
// See https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/commands.md
type DotnetInstallMode = 'sdk' | 'runtime' | 'aspnetcore';
type DotnetVersionSpecRequirement = 'equal' | 'greater_than_or_equal' | 'less_than_or_equal';

interface IDotnetAcquireContext {
  version: string;
  requestingExtensionId?: string;
  architecture?: string | null;
  mode?: DotnetInstallMode;
}

interface IDotnetFindPathContext {
  acquireContext: IDotnetAcquireContext;
  versionSpecRequirement: DotnetVersionSpecRequirement;
  rejectPreviews?: boolean;
}

interface IDotnetAcquireResult {
  dotnetPath: string;
}

/**
 * The resolved host used to launch the language server, together with any environment
 * variables that must be set so the host loads the intended runtime.
 */
export interface ResolvedDotnetRuntime {
  /** Path to the `dotnet` executable (or just `dotnet` when relying on PATH). */
  dotnetPath: string;
  /**
   * Environment overlay to apply when spawning the server. Empty when relying on PATH;
   * pins DOTNET_ROOT / DOTNET_MULTILEVEL_LOOKUP when the host was resolved or acquired
   * via the .NET Install Tool so the server runs on exactly that runtime.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * Thrown by {@link resolveDotnetRuntime} when no .NET runtime capable of hosting the
 * language server can be located or acquired. Callers should surface a single, actionable
 * message rather than letting the server crash-loop.
 */
export class DotnetRuntimeMissingError extends Error {
  constructor(
    public readonly requiredVersion: string,
    public readonly detail?: string,
  ) {
    super(
      `The GSharp language server requires the .NET ${requiredVersion} runtime, which was not found.`,
    );
    this.name = 'DotnetRuntimeMissingError';
  }
}

/**
 * Parses the output of `dotnet --list-runtimes` and reports whether a
 * `Microsoft.NETCore.App` runtime with a major version >= {@link requiredMajor} exists.
 *
 * Each line looks like: `Microsoft.NETCore.App 10.0.0 [/usr/share/dotnet/shared/...]`.
 */
export function hasCompatibleNetCoreAppRuntime(
  listRuntimesOutput: string,
  requiredMajor: number,
): boolean {
  if (!listRuntimesOutput) {
    return false;
  }

  for (const rawLine of listRuntimesOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('Microsoft.NETCore.App ')) {
      continue;
    }

    const match = /^Microsoft\.NETCore\.App\s+(\d+)\./.exec(line);
    if (match) {
      const major = Number.parseInt(match[1], 10);
      if (Number.isFinite(major) && major >= requiredMajor) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if the `dotnet` host on PATH exposes a compatible runtime. Returns false
 * when `dotnet` is absent or only ships older runtimes.
 */
function pathDotnetHasCompatibleRuntime(): boolean {
  try {
    const output = execFileSync('dotnet', ['--list-runtimes'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return hasCompatibleNetCoreAppRuntime(output, REQUIRED_DOTNET_MAJOR_VERSION);
  } catch {
    return false;
  }
}

/**
 * Validates that the dotnet host at {@link dotnetPath} can host the server. The
 * .NET Install Tool may hand back a host that only resolves older runtimes, so we
 * verify the runtime list before trusting it.
 */
function dotnetPathHasCompatibleRuntime(dotnetPath: string): boolean {
  try {
    const output = execFileSync(dotnetPath, ['--list-runtimes'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return hasCompatibleNetCoreAppRuntime(output, REQUIRED_DOTNET_MAJOR_VERSION);
  } catch {
    // If we cannot enumerate runtimes (e.g. an unexpected host layout), assume the
    // Install Tool knows what it returned rather than blocking startup outright.
    return true;
  }
}

/**
 * Builds the environment overlay that pins the server to the runtime beside
 * {@link dotnetPath}, matching the C# extension's behavior. This prevents the host from
 * rolling forward to (or down to) some other runtime discovered via multilevel lookup.
 */
function hostEnvironmentFor(dotnetPath: string): NodeJS.ProcessEnv {
  return {
    DOTNET_ROOT: path.dirname(dotnetPath),
    DOTNET_MULTILEVEL_LOOKUP: '0',
  };
}

/** Resolves the requesting architecture for acquisition (Node arch terminology). */
function currentArchitecture(): string {
  return process.arch;
}

/**
 * Asks the .NET Install Tool to locate an already-installed compatible runtime without
 * downloading anything. Returns the host path, or `undefined` if none is found.
 */
async function findExistingRuntime(logger: Logger): Promise<string | undefined> {
  const findPathRequest: IDotnetFindPathContext = {
    acquireContext: {
      version: REQUIRED_DOTNET_VERSION,
      requestingExtensionId: REQUESTING_EXTENSION_ID,
      architecture: currentArchitecture(),
      mode: 'runtime',
    },
    versionSpecRequirement: 'greater_than_or_equal',
    // Reject previews: the server is not started with DOTNET_ROLL_FORWARD_TO_PRERELEASE,
    // so a preview-only host would not actually be able to run it.
    rejectPreviews: true,
  };

  const result = await vscode.commands.executeCommand<IDotnetAcquireResult | undefined>(
    'dotnet.findPath',
    findPathRequest,
  );

  if (result?.dotnetPath && dotnetPathHasCompatibleRuntime(result.dotnetPath)) {
    logger.info(`Found existing .NET runtime via the .NET Install Tool: ${result.dotnetPath}`);
    return result.dotnetPath;
  }

  return undefined;
}

/**
 * Acquires a compatible runtime via the .NET Install Tool, downloading it into the
 * tool's user-level managed folder if it is not already present. Returns the host path,
 * or `undefined` if acquisition did not yield a usable host.
 */
async function acquireRuntime(logger: Logger): Promise<string | undefined> {
  // The acquire API only accepts a major.minor version; it installs the latest patch.
  const acquireContext: IDotnetAcquireContext = {
    version: REQUIRED_DOTNET_VERSION,
    requestingExtensionId: REQUESTING_EXTENSION_ID,
    architecture: currentArchitecture(),
    mode: 'runtime',
  };

  // Fast path: a previous acquisition may already have installed the runtime.
  let result = await vscode.commands.executeCommand<IDotnetAcquireResult | undefined>(
    'dotnet.acquireStatus',
    acquireContext,
  );

  if (!result?.dotnetPath) {
    logger.info(
      `No compatible .NET ${REQUIRED_DOTNET_VERSION} runtime found; acquiring one via the .NET Install Tool...`,
    );
    // Surface the Install Tool's own output channel so the user can watch download progress.
    await vscode.commands.executeCommand('dotnet.showAcquisitionLog');
    result = await vscode.commands.executeCommand<IDotnetAcquireResult | undefined>(
      'dotnet.acquire',
      acquireContext,
    );
  }

  if (!result?.dotnetPath) {
    return undefined;
  }

  // On Linux the runtime may need additional native dependencies before it can run.
  if (process.platform === 'linux') {
    try {
      await vscode.commands.executeCommand('dotnet.ensureDotnetDependencies', {
        command: result.dotnetPath,
        arguments: ['--list-runtimes'],
      });
    } catch (err) {
      logger.warn(
        `dotnet.ensureDotnetDependencies failed; continuing anyway: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  logger.info(`Acquired .NET runtime via the .NET Install Tool: ${result.dotnetPath}`);
  return result.dotnetPath;
}

/**
 * Resolves a `dotnet` host capable of running the GSharp language server, acquiring one
 * automatically when necessary.
 *
 * Resolution order:
 *   1. A `dotnet` on PATH that exposes a `Microsoft.NETCore.App` runtime >= the required major.
 *   2. An existing compatible runtime located via the ms-dotnettools.vscode-dotnet-runtime extension.
 *   3. A runtime downloaded and installed on demand via the same extension's acquire API.
 *
 * @throws {DotnetRuntimeMissingError} when no compatible runtime can be located or acquired
 * (e.g. the .NET Install Tool is unavailable or the machine is offline with nothing cached).
 */
export async function resolveDotnetRuntime(
  _context: vscode.ExtensionContext,
  logger: Logger,
): Promise<ResolvedDotnetRuntime> {
  // 1. Prefer a compatible runtime already on PATH (no Install Tool round-trip needed).
  if (pathDotnetHasCompatibleRuntime()) {
    logger.info('Using compatible .NET runtime found on PATH.');
    return { dotnetPath: 'dotnet', env: {} };
  }

  // 2 & 3. Use the .NET Install Tool to find or acquire a compatible runtime.
  const dotnetExtension = vscode.extensions.getExtension(DOTNET_INSTALL_TOOL_EXTENSION_ID);
  if (!dotnetExtension) {
    throw new DotnetRuntimeMissingError(
      REQUIRED_DOTNET_VERSION,
      'The .NET Install Tool extension is not available.',
    );
  }

  if (!dotnetExtension.isActive) {
    await dotnetExtension.activate();
  }

  try {
    const existing = await findExistingRuntime(logger);
    if (existing) {
      return { dotnetPath: existing, env: hostEnvironmentFor(existing) };
    }

    const acquired = await acquireRuntime(logger);
    if (acquired) {
      return { dotnetPath: acquired, env: hostEnvironmentFor(acquired) };
    }
  } catch (err) {
    logger.error('Failed to resolve a .NET runtime via the .NET Install Tool', err);
    throw new DotnetRuntimeMissingError(
      REQUIRED_DOTNET_VERSION,
      err instanceof Error ? err.message : String(err),
    );
  }

  throw new DotnetRuntimeMissingError(REQUIRED_DOTNET_VERSION);
}

export function getServerPath(context: vscode.ExtensionContext): string {
  const config = vscode.workspace.getConfiguration('gsharp');
  const configuredPath = config.get<string>('server.path', '');
  if (configuredPath) {
    return configuredPath;
  }

  // Use bundled server
  return path.join(context.extensionPath, '.server', 'GSharp.LanguageServer.dll');
}
