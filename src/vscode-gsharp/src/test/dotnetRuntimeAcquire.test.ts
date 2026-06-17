import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import {
  resolveDotnetRuntime,
  DotnetRuntimeMissingError,
  REQUIRED_DOTNET_VERSION,
} from '../utils/dotnetResolver';
import { Logger } from '../utils/logger';

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}));

const execFileSyncMock = childProcess.execFileSync as unknown as jest.Mock;
let executeCommandMock: jest.Mock;
let getExtensionMock: jest.Mock;

function fakeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  } as unknown as Logger;
}

const context = {} as vscode.ExtensionContext;

const NETCORE_10 = 'Microsoft.NETCore.App 10.0.0 [/x]';
const NETCORE_8 = 'Microsoft.NETCore.App 8.0.28 [/x]';

describe('resolveDotnetRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFileSyncMock.mockReset();
    executeCommandMock = jest.fn(async () => undefined);
    getExtensionMock = jest.fn(() => undefined);
    (vscode.commands as { executeCommand: unknown }).executeCommand = executeCommandMock;
    (vscode.extensions as { getExtension: unknown }).getExtension = getExtensionMock;
  });

  it('uses PATH dotnet when it exposes a compatible runtime (no Install Tool round-trip)', async () => {
    execFileSyncMock.mockReturnValue(NETCORE_10);

    const result = await resolveDotnetRuntime(context, fakeLogger());

    expect(result).toEqual({ dotnetPath: 'dotnet', env: {} });
    expect(getExtensionMock).not.toHaveBeenCalled();
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('returns the existing runtime found via dotnet.findPath and pins DOTNET_ROOT', async () => {
    // PATH only has .NET 8; findPath returns a managed .NET 10 host.
    execFileSyncMock.mockImplementation((cmd: string) =>
      cmd === 'dotnet' ? NETCORE_8 : NETCORE_10,
    );
    getExtensionMock.mockReturnValue({ isActive: true, activate: jest.fn() });
    executeCommandMock.mockImplementation(async (command: string) => {
      if (command === 'dotnet.findPath') {
        return { dotnetPath: '/managed/dotnet/dotnet' };
      }
      return undefined;
    });

    const result = await resolveDotnetRuntime(context, fakeLogger());

    expect(result.dotnetPath).toBe('/managed/dotnet/dotnet');
    expect(result.env.DOTNET_ROOT).toBe('/managed/dotnet');
    expect(result.env.DOTNET_MULTILEVEL_LOOKUP).toBe('0');
    // Must not have attempted to download when an existing runtime was found.
    expect(executeCommandMock).not.toHaveBeenCalledWith('dotnet.acquire', expect.anything());
  });

  it('acquires a runtime when none exists on PATH or via findPath', async () => {
    execFileSyncMock.mockImplementation((cmd: string) =>
      cmd === 'dotnet' ? NETCORE_8 : NETCORE_10,
    );
    getExtensionMock.mockReturnValue({ isActive: false, activate: jest.fn() });
    executeCommandMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'dotnet.findPath':
          return undefined;
        case 'dotnet.acquireStatus':
          return undefined;
        case 'dotnet.acquire':
          return { dotnetPath: '/acquired/dotnet/dotnet' };
        default:
          return undefined;
      }
    });

    const result = await resolveDotnetRuntime(context, fakeLogger());

    expect(result.dotnetPath).toBe('/acquired/dotnet/dotnet');
    expect(result.env.DOTNET_ROOT).toBe('/acquired/dotnet');
    expect(executeCommandMock).toHaveBeenCalledWith('dotnet.acquire', expect.objectContaining({
      version: REQUIRED_DOTNET_VERSION,
      mode: 'runtime',
    }));
  });

  it('throws DotnetRuntimeMissingError when the Install Tool is unavailable', async () => {
    execFileSyncMock.mockReturnValue(NETCORE_8);
    getExtensionMock.mockReturnValue(undefined);

    await expect(resolveDotnetRuntime(context, fakeLogger())).rejects.toBeInstanceOf(
      DotnetRuntimeMissingError,
    );
  });

  it('throws DotnetRuntimeMissingError when acquisition yields nothing', async () => {
    execFileSyncMock.mockReturnValue(NETCORE_8);
    getExtensionMock.mockReturnValue({ isActive: true, activate: jest.fn() });
    executeCommandMock.mockResolvedValue(undefined);

    await expect(resolveDotnetRuntime(context, fakeLogger())).rejects.toBeInstanceOf(
      DotnetRuntimeMissingError,
    );
  });
});
