import { getKillCommand } from '../features/processKill';

describe('getKillCommand', () => {
  it('uses taskkill /T /F on Windows to walk the whole process tree by pid', () => {
    expect(getKillCommand(1234, 'win32')).toEqual({
      command: 'taskkill',
      args: ['/pid', '1234', '/T', '/F'],
    });
  });

  it('targets the negative pid (process group) on POSIX platforms', () => {
    expect(getKillCommand(4321, 'darwin')).toEqual({ command: 'kill', args: ['-TERM', '-4321'] });
    expect(getKillCommand(4321, 'linux')).toEqual({ command: 'kill', args: ['-TERM', '-4321'] });
  });
});
