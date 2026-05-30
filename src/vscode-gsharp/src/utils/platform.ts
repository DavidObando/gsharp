import * as os from 'os';

export interface PlatformInfo {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
}

export function getPlatformInfo(): PlatformInfo {
  const platform = os.platform() as PlatformInfo['platform'];
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  return { platform, arch };
}

export function getServerExecutableName(): string {
  const { platform } = getPlatformInfo();
  if (platform === 'win32') {
    return 'GSharp.LanguageServer.exe';
  }
  return 'GSharp.LanguageServer';
}
