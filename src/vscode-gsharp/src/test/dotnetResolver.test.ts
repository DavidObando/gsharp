import {
  hasCompatibleNetCoreAppRuntime,
  DotnetRuntimeMissingError,
  REQUIRED_DOTNET_MAJOR_VERSION,
  REQUIRED_DOTNET_VERSION,
} from '../utils/dotnetResolver';

describe('hasCompatibleNetCoreAppRuntime', () => {
  const required = REQUIRED_DOTNET_MAJOR_VERSION;

  it('returns true when a runtime with the required major is present', () => {
    const output = [
      'Microsoft.AspNetCore.App 10.0.0 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]',
      'Microsoft.NETCore.App 10.0.0 [/usr/share/dotnet/shared/Microsoft.NETCore.App]',
    ].join('\n');
    expect(hasCompatibleNetCoreAppRuntime(output, required)).toBe(true);
  });

  it('returns true when a newer major runtime is present', () => {
    const output = 'Microsoft.NETCore.App 11.0.1 [/usr/share/dotnet/shared/Microsoft.NETCore.App]';
    expect(hasCompatibleNetCoreAppRuntime(output, required)).toBe(true);
  });

  it('returns false when only an older runtime is present (the issue #871 case)', () => {
    const output = 'Microsoft.NETCore.App 8.0.28 [/usr/share/dotnet/shared/Microsoft.NETCore.App]';
    expect(hasCompatibleNetCoreAppRuntime(output, required)).toBe(false);
  });

  it('ignores AspNetCore/WindowsDesktop runtimes when matching the shared framework', () => {
    const output = [
      'Microsoft.AspNetCore.App 10.0.0 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]',
      'Microsoft.WindowsDesktop.App 10.0.0 [/x]',
      'Microsoft.NETCore.App 8.0.28 [/usr/share/dotnet/shared/Microsoft.NETCore.App]',
    ].join('\n');
    expect(hasCompatibleNetCoreAppRuntime(output, required)).toBe(false);
  });

  it('handles CRLF line endings', () => {
    const output =
      'Microsoft.NETCore.App 8.0.28 [/x]\r\nMicrosoft.NETCore.App 10.0.0 [/y]\r\n';
    expect(hasCompatibleNetCoreAppRuntime(output, required)).toBe(true);
  });

  it('returns false for empty output', () => {
    expect(hasCompatibleNetCoreAppRuntime('', required)).toBe(false);
  });

  it('selects the highest available major across multiple lines', () => {
    const output = [
      'Microsoft.NETCore.App 6.0.0 [/x]',
      'Microsoft.NETCore.App 7.0.0 [/y]',
      'Microsoft.NETCore.App 9.0.0 [/z]',
    ].join('\n');
    expect(hasCompatibleNetCoreAppRuntime(output, required)).toBe(false);
    expect(hasCompatibleNetCoreAppRuntime(output, 9)).toBe(true);
  });
});

describe('DotnetRuntimeMissingError', () => {
  it('carries the required version and a descriptive message', () => {
    const err = new DotnetRuntimeMissingError(REQUIRED_DOTNET_VERSION);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DotnetRuntimeMissingError');
    expect(err.requiredVersion).toBe(REQUIRED_DOTNET_VERSION);
    expect(err.message).toContain(REQUIRED_DOTNET_VERSION);
  });
});
