import * as vscode from 'vscode';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * The major version of the .NET runtime the bundled GSharp language server targets
 * (see build/gsharp.build.props NetCoreAppTargetFramework = net10.0). The server cannot
 * be hosted by an older runtime, so we verify a compatible runtime is present before
 * launching it and degrade gracefully when it is missing.
 */
export const REQUIRED_DOTNET_MAJOR_VERSION = 10;

/** The `major.minor` string passed to the .NET Install Tool when locating a runtime. */
export const REQUIRED_DOTNET_VERSION = `${REQUIRED_DOTNET_MAJOR_VERSION}.0`;

/** Download page shown to the user when no compatible runtime can be found. */
export const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download/dotnet/10.0';

/**
 * Thrown by {@link resolveDotnetRuntime} when no .NET runtime capable of hosting the
 * language server can be located. Callers should surface a single, actionable message
 * rather than letting the server crash-loop.
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
 * Resolves a `dotnet` host capable of running the GSharp language server.
 *
 * Resolution order:
 *   1. A `dotnet` on PATH that exposes a `Microsoft.NETCore.App` runtime >= the required major.
 *   2. A runtime located (or acquired) via the ms-dotnettools.vscode-dotnet-runtime extension.
 *
 * @throws {DotnetRuntimeMissingError} when no compatible runtime can be located.
 */
export async function resolveDotnetRuntime(
  _context: vscode.ExtensionContext,
): Promise<string> {
  // 1. Prefer a compatible runtime already on PATH.
  if (pathDotnetHasCompatibleRuntime()) {
    return 'dotnet';
  }

  // 2. Ask the .NET Install Tool to find (or acquire) a compatible runtime.
  const dotnetExtension = vscode.extensions.getExtension(
    'ms-dotnettools.vscode-dotnet-runtime',
  );
  if (dotnetExtension) {
    if (!dotnetExtension.isActive) {
      await dotnetExtension.activate();
    }
    try {
      const result = await vscode.commands.executeCommand<{ dotnetPath: string } | undefined>(
        'dotnet.findPath',
        {
          acquireContext: {
            version: REQUIRED_DOTNET_VERSION,
            requestingExtensionId: 'gsharp.vscode-gsharp',
            mode: 'runtime',
          },
          versionSpecRequirement: 'greater_than_or_equal',
        },
      );
      if (result?.dotnetPath && dotnetPathHasCompatibleRuntime(result.dotnetPath)) {
        return result.dotnetPath;
      }
    } catch {
      // Fall through to the missing-runtime error below.
    }
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
