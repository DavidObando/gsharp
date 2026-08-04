// <copyright file="Issue3198LooseFileExtensionDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>Issue #3198: loose files resolve bundled extension references.</summary>
public sealed class Issue3198LooseFileExtensionDiagnosticsTests
{
    [Fact]
    public async Task LooseFileWithoutExtensions_PublishesNoDiagnostics()
    {
        var diagnostics = await GetPublishedDiagnosticsAsync(
            "AddressBook",
            File.ReadAllText(Path.Combine(LocateSamplesDirectory(), "AddressBook.gs")));

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData("GsharpExtensionsOptional")]
    [InlineData("GsharpExtensionsMixed")]
    [InlineData("GsharpExtensionsSequences")]
    public async Task LooseExtensionSample_PublishesNoDiagnostics(string sample)
    {
        var diagnostics = await GetPublishedDiagnosticsAsync(
            sample,
            File.ReadAllText(Path.Combine(LocateSamplesDirectory(), sample + ".gs")));

        Assert.True(
            diagnostics.Count == 0,
            string.Join(Environment.NewLine, diagnostics.Select(d => $"{d.Code.Value}: {d.Message}")));
    }

    [Fact]
    public async Task LooseFileWithPlainExtensionImport_PublishesNoDiagnostics()
    {
        var diagnostics = await GetPublishedDiagnosticsAsync(
            "PlainExtensionImport",
            """
            package Issue3198.Plain
            import System
            import Gsharp.Extensions.Sequences

            let values = Sequences.Of(7, 8, 9)
            Console.WriteLine(values[0])
            """);

        Assert.True(
            diagnostics.Count == 0,
            string.Join(Environment.NewLine, diagnostics.Select(d => $"{d.Code.Value}: {d.Message}")));
    }

    private static async Task<IReadOnlyList<Diagnostic>> GetPublishedDiagnosticsAsync(string name, string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3198LooseFileExtensionDiagnosticsTests),
            name + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.GetFileSystemEntries(directory));

        try
        {
            var sourcePath = Path.Combine(directory, name + ".gs");
            File.WriteAllText(sourcePath, source);
            var server = new LspServer(new DocumentContentService(), new WorkspaceState());
            var published = new TaskCompletionSource<IReadOnlyList<Diagnostic>>(TaskCreationOptions.RunContinuationsAsynchronously);
            var bindCompleted = 0;
            server.TestOnBindResult = (_, _) => Interlocked.Exchange(ref bindCompleted, 1);
            server.TestOnPublish = (_, diagnostics) =>
            {
                if (Volatile.Read(ref bindCompleted) == 1)
                {
                    published.TrySetResult(diagnostics);
                }
            };

            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem
                {
                    Uri = DocumentUri.FromFileSystemPath(sourcePath),
                    Text = source,
                },
            });

            return await published.Task.WaitAsync(TimeSpan.FromSeconds(30));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string LocateSamplesDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "samples");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return candidate;
            }
        }

        throw new DirectoryNotFoundException("Unable to locate samples directory");
    }
}
