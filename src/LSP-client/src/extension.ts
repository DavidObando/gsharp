'use strict';

import { workspace, Disposable, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, InitializeParams } from 'vscode-languageclient';
import { Trace } from 'vscode-jsonrpc';

export function activate(context: ExtensionContext) {
    let serverExe = 'dotnet';

    let serverOptions: ServerOptions = {
        run: { command: serverExe, args: ['run', '--project', context.extensionPath + '../../LSP/LSP.csproj', '--configuration', 'Release'] },
        debug: { command: serverExe, args: ['run', '--project', context.extensionPath + '../../LSP/LSP.csproj'] }
    }

    let clientOptions: LanguageClientOptions = {
        documentSelector: [
            {
                pattern: '**/*.gs',
            }
        ],
        synchronize: {
            configurationSection: 'gsharpLSPClient',
            fileEvents: workspace.createFileSystemWatcher('**/*.gs')
        },
    }

    const client = new LanguageClient('gsharpLSPClient', 'GSharp Language Server', serverOptions, clientOptions);
    client.trace = Trace.Verbose;
    let disposable = client.start();

    context.subscriptions.push(disposable);
}