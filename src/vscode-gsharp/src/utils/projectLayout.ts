import * as fs from 'fs';
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
 * Evaluated metadata for a `.gsproj` file.
 */
export interface ProjectMetadata {
  /** Absolute path to the `.gsproj` file. */
  projectPath: string;
  /** File stem without `.gsproj`. */
  projectName: string;
  /** Evaluated `<AssemblyName>`, or `projectName` when omitted. */
  assemblyName: string;
  /** Evaluated `<TargetFramework>`, or `net10.0` when omitted. */
  targetFramework: string;
  /** Evaluated `<OutputType>`, or `Library` when omitted. */
  outputType: string;
  /** Whether the project is a test project. */
  isTestProject: boolean;
  /** Whether the project produces a runnable executable (`Exe` or `WinExe`, non-test). */
  isRunnable: boolean;
}

function collectInheritedPropsFiles(projectDir: string): string[] {
  const files: string[] = [];
  let dir = projectDir;
  for (let depth = 0; depth < 16; depth++) {
    const candidate = path.join(dir, 'Directory.Build.props');
    if (fs.existsSync(candidate)) {
      files.unshift(candidate);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return files;
}

function extractXmlProperties(xml: string, target: Map<string, string>): void {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, '');
  const propPattern = /<([A-Za-z_][A-Za-z0-9_.-]*)\b[^>]*>([^<]*)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = propPattern.exec(stripped)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (value) {
      target.set(key, value);
    }
  }
}

function resolveMsBuildVariables(value: string, props: ReadonlyMap<string, string>): string {
  return value.replace(/\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/g, (full, name: string) => {
    const replacement = props.get(name.toLowerCase());
    return replacement !== undefined ? replacement : full;
  });
}

/**
 * Parses `<OutputType>`, `<AssemblyName>`, `<TargetFramework>`, and test-project
 * markers from a `.gsproj` file (and any ancestor `Directory.Build.props`).
 */
export function parseProjectMetadata(projectPath: string, projectXml?: string): ProjectMetadata {
  const projectName = path.basename(projectPath, '.gsproj');
  const props = new Map<string, string>([
    ['msbuildprojectname', projectName],
    ['msbuildprojectfile', path.basename(projectPath)],
  ]);

  let rawProjectXml = projectXml;
  if (rawProjectXml === undefined && fs.existsSync(projectPath)) {
    try {
      for (const propsFile of collectInheritedPropsFiles(path.dirname(projectPath))) {
        extractXmlProperties(fs.readFileSync(propsFile, 'utf8'), props);
      }
      rawProjectXml = fs.readFileSync(projectPath, 'utf8');
    } catch {
      rawProjectXml = undefined;
    }
  }

  let hasTestSdkPackage = false;
  if (rawProjectXml !== undefined) {
    extractXmlProperties(rawProjectXml, props);
    const stripped = rawProjectXml.replace(/<!--[\s\S]*?-->/g, '');
    hasTestSdkPackage =
      /<PackageReference\b[^>]*\bInclude\s*=\s*["']Microsoft\.NET\.Test\.Sdk["']/i.test(stripped);
  }

  const outputType = resolveMsBuildVariables(props.get('outputtype') ?? 'Library', props).trim();
  const isTestProp = resolveMsBuildVariables(props.get('istestproject') ?? '', props).trim();
  const isTestProject =
    /^true$/i.test(isTestProp) || hasTestSdkPackage || /\.Tests?\.gsproj$/i.test(projectPath);
  const isRunnable = /^(?:Exe|WinExe)$/i.test(outputType) && !isTestProject;

  const rawAssemblyName = resolveMsBuildVariables(props.get('assemblyname') ?? '', props).trim();
  const assemblyName =
    rawAssemblyName && !rawAssemblyName.includes('$(') ? rawAssemblyName : projectName;

  const rawTargetFramework = resolveMsBuildVariables(
    props.get('targetframework') ?? (props.get('targetframeworks') ?? '').split(';')[0] ?? '',
    props,
  ).trim();
  const targetFramework =
    rawTargetFramework && !rawTargetFramework.includes('$(') ? rawTargetFramework : 'net10.0';

  return {
    projectPath,
    projectName,
    assemblyName,
    targetFramework,
    outputType,
    isTestProject,
    isRunnable,
  };
}

/**
 * Computes a `${workspaceFolder}`-relative path for a `.gsproj` file in `tasks.json`,
 * falling back to the absolute path only when the project is outside the workspace folder.
 */
export function computeWorkspaceTaskPath(
  workspaceFolderPath: string,
  projectPath: string,
): string {
  const relPath = path.relative(workspaceFolderPath, projectPath).split(path.sep).join('/');
  if (relPath && relPath !== '.' && !relPath.startsWith('..') && !path.isAbsolute(relPath)) {
    return `\${workspaceFolder}/${relPath}`;
  }
  return projectPath;
}

/**
 * Returns the runnable (`OutputType` `Exe`/`WinExe`, non-test) projects from
 * `projectPaths` in deterministic workspace-relative order.
 */
export function findRunnableProjects(
  projectPaths: readonly string[],
  workspaceFolderPath?: string,
): ProjectMetadata[] {
  const sorted = [...projectPaths].sort((left, right) => {
    const leftKey = workspaceFolderPath
      ? path.relative(workspaceFolderPath, left).split(path.sep).join('/')
      : left.split(path.sep).join('/');
    const rightKey = workspaceFolderPath
      ? path.relative(workspaceFolderPath, right).split(path.sep).join('/')
      : right.split(path.sep).join('/');
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return sorted.map((p) => parseProjectMetadata(p)).filter((m) => m.isRunnable);
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
 * @param targetFramework Optional target framework override (defaults to `<TargetFramework>` or `net10.0`).
 * @param assemblyName Optional assembly name override (defaults to `<AssemblyName>` or project filename stem).
 */
export function computeLaunchPaths(
  workspaceFolderPath: string,
  projectPath: string,
  targetFramework?: string,
  assemblyName?: string,
): LaunchPaths {
  const metadata =
    targetFramework === undefined || assemblyName === undefined
      ? parseProjectMetadata(projectPath)
      : undefined;
  const resolvedTfm = targetFramework ?? metadata?.targetFramework ?? 'net10.0';
  const resolvedAssemblyName =
    assemblyName ?? metadata?.assemblyName ?? path.basename(projectPath, '.gsproj');
  const projectDir = path.dirname(projectPath);
  const relDir = path.relative(workspaceFolderPath, projectDir).split(path.sep).join('/');

  // Root the paths at ${workspaceFolder}. When the project sits in a
  // subdirectory, include that relative segment; when it is at the root (or
  // resolves outside the workspace), fall back to the workspace folder itself.
  const base =
    relDir && relDir !== '.' && !relDir.startsWith('..') && !path.isAbsolute(relDir)
      ? `\${workspaceFolder}/${relDir}`
      : '${workspaceFolder}';

  return {
    program: `${base}/bin/Debug/${resolvedTfm}/${resolvedAssemblyName}.dll`,
    cwd: base,
  };
}
