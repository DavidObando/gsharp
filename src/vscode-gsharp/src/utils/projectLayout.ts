import * as path from 'path';

/**
 * The `${workspaceFolder}`-rooted launch paths for a project.
 */
export interface LaunchPaths {
  /** Path to the built assembly, e.g. `${workspaceFolder}/MyLib/bin/Debug/net10.0/MyLib.dll`. */
  program: string;
  /** Working directory for the launched process. */
  cwd: string;
}

/**
 * Computes the `${workspaceFolder}`-rooted `program`/`cwd` for a project.
 *
 * The `.gsproj` is not always at the workspace root: solution scaffolds (e.g.
 * `dotnet new gsharp-xunit`) place each project in its own subdirectory. The
 * generated launch config must point at the project's *own* `bin/` output, not
 * at `${workspaceFolder}/bin`, otherwise the debug target and `cwd` are wrong.
 *
 * @param workspaceFolderPath Absolute path to the opened workspace folder.
 * @param projectPath Absolute path to the `.gsproj` file.
 * @param targetFramework The target framework moniker (defaults to `net10.0`).
 */
export function computeLaunchPaths(
  workspaceFolderPath: string,
  projectPath: string,
  targetFramework = 'net10.0',
): LaunchPaths {
  const projectName = path.basename(projectPath, '.gsproj');
  const projectDir = path.dirname(projectPath);
  const relDir = path.relative(workspaceFolderPath, projectDir).split(path.sep).join('/');

  // Root the paths at ${workspaceFolder}. When the project sits in a
  // subdirectory, include that relative segment; when it is at the root (or
  // resolves outside the workspace), fall back to the workspace folder itself.
  const base =
    relDir && relDir !== '.' && !relDir.startsWith('..')
      ? `\${workspaceFolder}/${relDir}`
      : '${workspaceFolder}';

  return {
    program: `${base}/bin/Debug/${targetFramework}/${projectName}.dll`,
    cwd: base,
  };
}
