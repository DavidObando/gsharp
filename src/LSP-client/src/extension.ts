'use strict';

import { workspace, Disposable, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, InitializeParams } from 'vscode-languageclient';
import { Trace } from 'vscode-jsonrpc';

export function activate(context: ExtensionContext) {
    const serverExe = 'dotnet';
    const serverOptions: ServerOptions = {
        run: { command: serverExe, args: [context.extensionPath + '\\out\\GSharp.LSP.dll'] },
        debug: { command: serverExe, args: ['run', '--project', context.extensionPath + '../../LSP/LSP.csproj'] }
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            {
                pattern: '**/*.gs',
                scheme: 'file'
            }
        ],
        synchronize: {
            configurationSection: 'gsharpLSPClient',
            fileEvents: workspace.createFileSystemWatcher('**/*.gs')
        },
    }

    const client = new LanguageClient('gsharpLSPClient', 'GSharp Language Server', serverOptions, clientOptions);
    client.trace = Trace.Verbose;
    const disposable = client.start();

    context.subscriptions.push(disposable);
}