import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/**
 * Middleware and configuration for on-type formatting.
 * The actual formatting is handled by the language server; this module
 * provides the client-side trigger character configuration.
 */
export function getFormattingOptions(): { triggerCharacters: string[] } {
  return {
    triggerCharacters: [';', '}', '\n'],
  };
}

/**
 * Registers formatting-related commands if needed.
 */
export function registerFormattingFeatures(
  _context: vscode.ExtensionContext,
  _client: LanguageClient,
) {
  // The LSP client handles document formatting and range formatting automatically
  // when the server advertises the capability. On-type formatting trigger characters
  // are configured via the client options.
}
