// <copyright file="Issue3198LooseFileExtensionDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3198: loose files resolve bundled extension references.
@Collection("Issue3198AppContext")
class Issue3198LooseFileExtensionDiagnosticsTests {
    @Fact
    async func LooseFileWithoutExtensions_PublishesNoDiagnostics() {
        let diagnostics = await GetPublishedDiagnosticsAsync(
            "AddressBook",
            File.ReadAllText(Path.Combine(LocateSamplesDirectory(), "AddressBook.gs"))
        )
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData("GsharpExtensionsOptional")
    @InlineData("GsharpExtensionsMixed")
    @InlineData("GsharpExtensionsSequences")
    async func LooseExtensionSample_PublishesNoDiagnostics(sample string) {
        let diagnostics = await GetPublishedDiagnosticsAsync(
            sample,
            File.ReadAllText(Path.Combine(LocateSamplesDirectory(), sample + ".gs"))
        )
        Assert.True(
            diagnostics.Count == 0,
            string.Join(
                Environment.NewLine,
                diagnostics.Select((d GSharp.LanguageServer.Protocol.Diagnostic) -> "${d.Code!!.Value}: ${d.Message}")
            )
        )
    }

    @Fact
    async func LooseFileWithPlainExtensionImport_PublishesNoDiagnostics() {
        let diagnostics = await GetPublishedDiagnosticsAsync("PlainExtensionImport", `package Issue3198.Plain
import System
import Gsharp.Extensions.Sequences

let values = Sequences.Of(7, 8, 9)
Console.WriteLine(values[0])`)
        Assert.True(
            diagnostics.Count == 0,
            string.Join(
                Environment.NewLine,
                diagnostics.Select((d GSharp.LanguageServer.Protocol.Diagnostic) -> "${d.Code!!.Value}: ${d.Message}")
            )
        )
    }

    @Fact
    func CorruptBundledExtension_PublishesDiagnosticInsteadOfThrowing() {
        let originalBaseDirectory object? = AppContext.GetData("APP_CONTEXT_BASE_DIRECTORY")
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue3198LooseFileExtensionDiagnosticsTests",
            "corrupt-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        Assert.Empty(Directory.GetFileSystemEntries(directory))
        try {
            File.WriteAllText(Path.Combine(directory, "Gsharp.Extensions.dll"), "not a managed assembly")
            AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", directory)
            let syntaxTree = SyntaxTree.Parse("package Issue3198.Corrupt\nlet broken TotallyUndefinedType = nil")
            let compilation = Compilation(syntaxTree)
            let diagnostics = compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics)
            Assert.Contains(
                diagnostics,
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Message.Contains(
                    "TotallyUndefinedType",
                    StringComparison.Ordinal
                )
            )
        } finally {
            AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", originalBaseDirectory)
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private async func GetPublishedDiagnosticsAsync(name string, source string) IReadOnlyList[
            GSharp.LanguageServer.Protocol.Diagnostic
        ] {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3198LooseFileExtensionDiagnosticsTests",
                name + "-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.GetFileSystemEntries(directory))
            try {
                let sourcePath = Path.Combine(directory, name + ".gs")
                File.WriteAllText(sourcePath, source)
                let server = LspServer(DocumentContentService(), WorkspaceState())
                let published = TaskCompletionSource[IReadOnlyList[GSharp.LanguageServer.Protocol.Diagnostic]](
                    TaskCreationOptions.RunContinuationsAsynchronously
                )
                var bindCompleted = 0
                server.TestOnBindResult = (_ DocumentUri, _ DiagnosticComputationResult) -> Interlocked.Exchange(
                    &bindCompleted,
                    1
                )
                server.TestOnPublish = (
                    _ DocumentUri,
                    diagnostics IReadOnlyList[GSharp.LanguageServer.Protocol.Diagnostic]
                ) -> {
                    if Volatile.Read(&bindCompleted) == 1 {
                        published.TrySetResult(diagnostics)
                    }
                }
                await server.DidOpenAsync(
                    DidOpenTextDocumentParams{
                        TextDocument: TextDocumentItem{Uri: DocumentUri.FromFileSystemPath(sourcePath)!!, Text: source}
                    }
                )
                return await published.Task.WaitAsync(TimeSpan.FromSeconds(30))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func LocateSamplesDirectory() string {
            for var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory);
                directory != nil;
                directory = directory!!
                .Parent {
                let candidate = Path.Combine(directory.FullName, "samples")
                if Directory.Exists(candidate) && RepositoryRootMarker.IsRoot(directory.FullName) {
                    return candidate
                }
            }
            throw DirectoryNotFoundException("Unable to locate samples directory")
        }
    }
}

@CollectionDefinition("Issue3198AppContext", DisableParallelization = true)
class Issue3198AppContextCollection { }
