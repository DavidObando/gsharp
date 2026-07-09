import * as path from 'path';
import { computeLaunchPaths } from '../utils/projectLayout';

describe('computeLaunchPaths', () => {
  it('roots paths at the project subdirectory for a solution layout', () => {
    const ws = path.join(path.sep, 'home', 'me', 'Temp');
    const project = path.join(ws, 'Temp', 'Temp.gsproj');

    const { program, cwd } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/Temp/bin/Debug/net10.0/Temp.dll');
    expect(cwd).toBe('${workspaceFolder}/Temp');
  });

  it('uses the workspace folder directly when the project is at the root', () => {
    const ws = path.join(path.sep, 'home', 'me', 'App');
    const project = path.join(ws, 'App.gsproj');

    const { program, cwd } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/bin/Debug/net10.0/App.dll');
    expect(cwd).toBe('${workspaceFolder}');
  });

  it('handles nested subdirectories', () => {
    const ws = path.join(path.sep, 'work', 'repo');
    const project = path.join(ws, 'src', 'Server', 'Server.gsproj');

    const { program } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/src/Server/bin/Debug/net10.0/Server.dll');
  });

  it('honors a custom target framework', () => {
    const ws = path.join(path.sep, 'w');
    const project = path.join(ws, 'Lib', 'Lib.gsproj');

    const { program } = computeLaunchPaths(ws, project, 'net9.0');

    expect(program).toBe('${workspaceFolder}/Lib/bin/Debug/net9.0/Lib.dll');
  });

  it('falls back to the workspace folder when the project is outside it', () => {
    const ws = path.join(path.sep, 'home', 'me', 'inside');
    const project = path.join(path.sep, 'home', 'me', 'outside', 'Other.gsproj');

    const { program, cwd } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/bin/Debug/net10.0/Other.dll');
    expect(cwd).toBe('${workspaceFolder}');
  });
});
