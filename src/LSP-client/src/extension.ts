'use strict';

import { workspace, Disposable, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, InitializeParams } from 'vscode-languageclient';
import { Trace } from 'vscode-jsonrpc';

export function activate(context: ExtensionContext) {

    // The server is implemented in node
    let serverExe = 'dotnet';

    let serverOptions: ServerOptions = {
        run: { command: serverExe, args: ['run', '--project', context.extensionPath + '../../LSP/LSP.csproj', '--configuration', 'Release'] },
        debug: { command: serverExe, args: ['run', '--project', context.extensionPath + '../../LSP/LSP.csproj'] }
    }

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        // Register the server for plain text documents
        documentSelector: [
            {
                pattern: '**/*.gs',
            }
        ],
        synchronize: {
            // Synchronize the setting section 'gsharpLSPClient' to the server
            configurationSection: 'gsharpLSPClient',
            fileEvents: workspace.createFileSystemWatcher('**/*.gs')
        },
    }

    // Create the language client and start the client.
    const client = new LanguageClient('gsharpLSPClient', 'GSharp Language Server', serverOptions, clientOptions);
    client.trace = Trace.Verbose;
    let disposable = client.start();

    // Push the disposable to the context's subscriptions so that the
    // client can be deactivated on extension deactivation
    context.subscriptions.push(disposable);
}