import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '../..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'),
);
const properties = manifest.contributes.configuration[0].properties;
const serverOptions = fs.readFileSync(
  path.join(extensionRoot, 'src/server/serverOptions.ts'),
  'utf8',
);
const serverManager = fs.readFileSync(
  path.join(extensionRoot, 'src/server/serverManager.ts'),
  'utf8',
);

const initializationSettings = [
  'formatting.indentSize',
  'formatting.useTabs',
  'diagnostics.enableOnType',
  'completion.triggerOnDot',
  'codeLens.enableReferences',
  'inlayHints.enableParameterNames',
  'inlayHints.enableTypeHints',
  'coldStartCache.enable',
];

describe('language server settings', () => {
  it.each(initializationSettings)('wires gsharp.%s and documents restart semantics', (key) => {
    expect(serverOptions).toContain(`'${key}'`);
    const setting = properties[`gsharp.${key}`];
    expect(setting).toBeDefined();
    expect(setting.description ?? setting.markdownDescription).toMatch(/restart/i);
  });

  it('does not declare the unused start timeout setting', () => {
    expect(properties['gsharp.server.startTimeout']).toBeUndefined();
  });

  it('uses vscode-languageclient native protocol tracing', () => {
    expect(properties['gsharp.trace.server']).toBeDefined();
    expect(serverManager).toContain('traceOutputChannel: traceChannel');
    expect(serverOptions).not.toContain("config.get<string>('trace.server'");
  });

  it('only waits for a server debugger when explicitly configured', () => {
    expect(serverManager).toContain("if (options.waitForDebugger)");
    expect(serverManager).not.toContain("args: [...args, '--debug']");
  });

  it('does not retain unregistered feature and command modules', () => {
    for (const file of [
      'src/features/formatting.ts',
      'src/features/codeLens.ts',
      'src/features/inlayHints.ts',
      'src/commands/serverCommands.ts',
    ]) {
      expect(fs.existsSync(path.join(extensionRoot, file))).toBe(false);
    }
  });
});
