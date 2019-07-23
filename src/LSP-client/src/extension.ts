'use strict';

import { workspace, Disposable, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, InitializeParams } from 'vscode-languageclient';
import { Trace } from 'vscode-jsonrpc';

export function activate(context: ExtensionContext) {

    // The server is implemented in node
    let serverExe = 'dotnet';

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    let serverOptions: ServerOptions = {
        run: { command: serverExe, args: ['C:\\GIT\\gsharp\\out\\bin\\Debug\\LSP\\GSharp.LSP.dll'] },
        debug: { command: serverExe, args: ['C:\\GIT\\gsharp\\out\\bin\\Debug\\LSP\\GSharp.LSP.dll'] }
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