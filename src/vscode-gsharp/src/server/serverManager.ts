import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  TransportKind,
  InitializeParams,
  ErrorAction,
  CloseAction,
} from 'vscode-languageclient/node';

class GSharpLanguageClient extends LanguageClient {
  protected fillInitializeParams(params: InitializeParams): void {
    super.fillInitializeParams(params);
    
    // The GSharp language server advertises all capabilities statically in the initialize
    // response and does not support dynamic (client/registerCapability) registration. Strip
    // dynamicRegistration from the client capabilities so the client relies on static registration.
    const disableDynamicRegistration = (obj: unknown): void => {
      if (typeof obj !== 'object' || obj === null) {
        return;
      }
      const record = obj as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key === 'dynamicRegistration') {
          record[key] = false;
        } else {
          disableDynamicRegistration(record[key]);
        }
      }
    };
    disableDynamicRegistration(params.capabilities);
  }
}

import {
  resolveDotnetRuntime,
  getServerPath,
  DotnetRuntimeMissingError,
  DOTNET_DOWNLOAD_URL,
  ResolvedDotnetRuntime,
} from '../utils/dotnetResolver';
import { getServerOptions } from './serverOptions';
import { Logger } from '../utils/logger';

const MAX_RESTART_ATTEMPTS = 5;

export class ServerManager {
  private client: LanguageClient | undefined;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<void> | undefined;
  private isStopping = false;
  private fatalError = false;
  private statusItem: vscode.LanguageStatusItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.statusItem = vscode.languages.createLanguageStatusItem('gsharp.serverStatus', {
      language: 'gsharp',
    });
    this.statusItem.name = 'GSharp Language Server';
    this.setStatus('starting');
    context.subscriptions.push(this.statusItem);
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.isStopping = false;
    this.clearRestartTimer();

    const startPromise = this.doStart().finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    });

    this.startPromise = startPromise;
    return startPromise;
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.clearRestartTimer();

    const client = this.client;
    this.client = undefined;

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // The startup path already logged the failure.
      }
    }

    if (client) {
      await this.stopClient(client);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    this.restartCount = 0;
    this.fatalError = false;
    await this.start();
  }

  getClient(): LanguageClient | undefined {
    return this.client;
  }

  private async doStart(): Promise<void> {
    let client: LanguageClient | undefined;

    try {
      this.setStatus('starting');

      let dotnetRuntime: ResolvedDotnetRuntime;
      try {
        dotnetRuntime = await resolveDotnetRuntime(this.context, this.logger);
      } catch (err) {
        if (err instanceof DotnetRuntimeMissingError) {
          this.reportMissingRuntime(err);
          return;
        }
        throw err;
      }
      const dotnetPath = dotnetRuntime.dotnetPath;

      const serverPath = getServerPath(this.context);
      const options = getServerOptions();

      if (!fs.existsSync(serverPath)) {
        this.reportMissingServer(serverPath);
        return;
      }

      const args = [serverPath];
      if (options.waitForDebugger) {
        args.push('--debug');
      }
      if (options.log) {
        args.push(options.logPath ? `--log=${options.logPath}` : '--log');
      }

      this.logger.info(`Using dotnet: ${dotnetPath}`);
      this.logger.info(`Using server: ${serverPath}`);
      this.logger.info(`Launching: ${dotnetPath} ${args.join(' ')}`);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Pin the host to the resolved/acquired runtime (DOTNET_ROOT, DOTNET_MULTILEVEL_LOOKUP).
        ...dotnetRuntime.env,
        DOTNET_EnableDiagnostics: '0',
        DOTNET_CLI_UI_LANGUAGE: 'en',
        DOTNET_NOLOGO: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      };

      // ADR-0107: the server reads GSHARP_DISABLE_COLD_START_CACHE; map the
      // gsharp.coldStartCache.enable setting (with the C# Dev Kit fallback,
      // resolved in getServerOptions) onto it so the toggle takes effect on the
      // next server start.
      if (!options.coldStartCacheEnabled) {
        env.GSHARP_DISABLE_COLD_START_CACHE = '1';
      }

      const serverOptions: ServerOptions = {
        run: { command: dotnetPath, args, transport: TransportKind.stdio, options: { env } },
        debug: {
          command: dotnetPath,
          args: [...args, '--debug'],
          transport: TransportKind.stdio,
          options: { env },
        },
      };

      const traceChannel = vscode.window.createOutputChannel('GSharp LSP Trace');
      this.context.subscriptions.push(traceChannel);

      // Watch .gs, .gsproj, and .resx files so the server's workspace model
      // (owning-project lookup, symbol/diagnostic caches) stays in sync with
      // creates/deletes/renames and project-reference edits, and so saving a
      // .resx regenerates its Resources.Designer.gs codebehind (ADR-0142,
      // issue #2200). vscode-languageclient registers this watcher client-side
      // (LanguageClient.hookFileEvents), independent of dynamicRegistration,
      // so it works even though GSharpLanguageClient strips dynamicRegistration below.
      const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{gs,gsproj,resx}');
      this.context.subscriptions.push(fileWatcher);

      const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'gsharp' }],
        traceOutputChannel: traceChannel,
        diagnosticPullOptions: {
          onChange: true,
          onSave: true,
        },
        synchronize: {
          fileEvents: fileWatcher,
        },
        // ServerManager owns the restart policy (see handleServerStopped), so suppress
        // the LanguageClient's own crash toasts and "crashed N times" cascade and route
        // everything through our logger / status item instead.
        initializationFailedHandler: (error) => {
          this.logger.error('Language server initialization failed', error);
          return false;
        },
        errorHandler: {
          error: () => ({ action: ErrorAction.Continue, handled: true }),
          closed: () => ({ action: CloseAction.DoNotRestart, handled: true }),
        },
        initializationOptions: {
          formattingIndentSize: vscode.workspace
            .getConfiguration('gsharp')
            .get<number>('formatting.indentSize', 4),
          formattingUseTabs: vscode.workspace
            .getConfiguration('gsharp')
            .get<boolean>('formatting.useTabs', false),
        }
      };

      client = new GSharpLanguageClient('gsharp', 'GSharp Language Server', serverOptions, clientOptions);
      this.client = client;

      client.onDidChangeState((e) => {
        this.logger.info(`LSP client state: ${e.oldState} → ${e.newState}`);

        if (this.client !== client) {
          return;
        }

        if (e.newState === State.Running) {
          this.setStatus('ready');
          this.restartCount = 0;
          return;
        }

        if (e.oldState === State.Running && e.newState === State.Stopped) {
          this.client = undefined;
          this.handleServerStopped();
        }
      });

      await client.start();

      if (this.client !== client || this.isStopping) {
        await this.stopClient(client);
        return;
      }

      this.setStatus('ready');
      this.restartCount = 0;
      this.logger.info('Language server started.');
    } catch (err) {
      if (this.client === client) {
        this.client = undefined;
      }

      this.setStatus('error');
      this.logger.error('Failed to start language server', err);
      this.handleServerStopped();
    }
  }

  private handleServerStopped() {
    if (this.isStopping || this.fatalError || this.restartTimer) {
      return;
    }

    if (this.restartCount < MAX_RESTART_ATTEMPTS) {
      this.restartCount++;
      const delay = Math.min(1000 * Math.pow(2, this.restartCount - 1), 30000);
      this.logger.warn(
        `Server stopped unexpectedly. Restarting (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS}) in ${delay}ms...`,
      );
      this.setStatus('starting');
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        void this.start();
      }, delay);
    } else {
      this.setStatus('error');
      this.logger.error(
        `Server failed to restart after ${MAX_RESTART_ATTEMPTS} attempts. Use "GSharp: Restart Language Server" to try again.`,
      );
    }
  }

  private clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private async stopClient(client: LanguageClient): Promise<void> {
    if (!client.needsStop()) {
      return;
    }

    try {
      await client.stop();
    } catch (err) {
      this.logger.warn(`Failed to stop language server cleanly: ${this.formatError(err)}`);
    }
  }

  private reportMissingRuntime(err: DotnetRuntimeMissingError) {
    // A missing runtime is unrecoverable without user action: stop the restart loop
    // and surface a single, actionable message instead of a stream of crash toasts.
    this.fatalError = true;
    this.clearRestartTimer();
    this.client = undefined;
    this.setStatus('error');
    this.logger.error(err.message);

    const message =
      `${err.message} Automatic acquisition via the .NET Install Tool did not succeed ` +
      `(you may be offline). Install the .NET ${err.requiredVersion} runtime manually, then run ` +
      `"GSharp: Restart Language Server".`;
    void vscode.window
      .showErrorMessage(message, 'Install .NET', 'Show Output')
      .then((selection) => {
        if (selection === 'Install .NET') {
          void vscode.env.openExternal(vscode.Uri.parse(DOTNET_DOWNLOAD_URL));
        } else if (selection === 'Show Output') {
          this.logger.show();
        }
      });
  }

  private reportMissingServer(serverPath: string) {
    const message = `GSharp language server not found at ${serverPath}. Set "gsharp.server.path" to a valid GSharp.LanguageServer.dll path.`;
    this.client = undefined;
    this.setStatus('error');
    this.logger.error(message);
    void vscode.window.showErrorMessage(message, 'Open Settings').then((selection) => {
      if (selection === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'gsharp.server.path');
      }
    });
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }

  private setStatus(state: 'starting' | 'ready' | 'error') {
    switch (state) {
      case 'starting':
        this.statusItem.text = '$(loading~spin) Starting...';
        this.statusItem.severity = vscode.LanguageStatusSeverity.Information;
        break;
      case 'ready':
        this.statusItem.text = '$(check) Ready';
        this.statusItem.severity = vscode.LanguageStatusSeverity.Information;
        break;
      case 'error':
        this.statusItem.text = '$(error) Error';
        this.statusItem.severity = vscode.LanguageStatusSeverity.Error;
        break;
    }
  }
}
