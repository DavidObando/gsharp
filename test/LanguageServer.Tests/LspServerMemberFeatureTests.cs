// <copyright file="LspServerMemberFeatureTests.cs" company="GSharp">
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

/// <summary>
/// End-to-end coverage (through the real <see cref="LspServer"/> request pipeline, including
/// didOpen, diagnostic pulls and didChange edits) for class-member features that resolve a
/// property/field receiver: go-to-definition, member completion, and reference code lens.
/// Regression guard for the member-symbol resolution gaps that returned no result.
/// </summary>
public class LspServerMemberFeatureTests
{
    [Fact]
    public async Task PropertyMemberFeatures_WorkAfterEditsAndDiagnostics()
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gsmf_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);
        try
        {
            File.WriteAllText(
                Path.Combine(projDir, "Demo.gsproj"),
                "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

            var v1 = "package Demo\n\nclass Rect {\n    prop Width int32\n    prop Height int32\n    func Area() int32 { return Width }\n}\n";
            var gsPath = Path.Combine(projDir, "Rect.gs");
            File.WriteAllText(gsPath, v1);

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, rootDir);
            var server = new LspServer(new DocumentContentService(), workspace);
            var uri = DocumentUri.FromFileSystemPath(gsPath);
            var id = new TextDocumentIdentifier { Uri = uri };

            await server.DidOpenAsync(new DidOpenTextDocumentParams { TextDocument = new TextDocumentItem { Uri = uri, Text = v1 } });
            _ = await server.DocumentDiagnosticAsync(new DocumentDiagnosticParams { TextDocument = id }, CancellationToken.None);

            // Edit (didChange), then pull diagnostics — mirrors the real editor lifecycle.
            var v2 = "package Demo\n\nclass Rect {\n    prop Width int32\n    prop Height int32\n    func Area() int32 { return Width * Height }\n}\n";
            File.WriteAllText(gsPath, v2);
            await ChangeAsync(server, uri, v2, 2);
            _ = await server.DocumentDiagnosticAsync(new DocumentDiagnosticParams { TextDocument = id }, CancellationToken.None);

            // 1) go-to-definition on the implicit-this property usage `Width`.
            var def = await server.DefinitionAsync(new DefinitionParams { TextDocument = id, Position = LanguageServerTestHelpers.PositionOf(v2, "Width", 1) });
            Assert.NotNull(def);
            Assert.Equal(3, def.Range.Start.Line); // `prop Width` declaration

            // 2) reference code lens is produced for the file.
            var lenses = await server.CodeLensAsync(new CodeLensParams { TextDocument = id });
            Assert.NotNull(lenses);
            Assert.NotEmpty(lenses);

            // 3) member completion after `Width.` (property receiver).
            var v3 = "package Demo\n\nclass Rect {\n    prop Width int32\n    prop Height int32\n    func Area() int32 { return Width. }\n}\n";
            File.WriteAllText(gsPath, v3);
            await ChangeAsync(server, uri, v3, 3);
            var dotPos = LanguageServerTestHelpers.PositionOf(v3, "Width.", 0);
            var completion = await server.CompletionAsync(new CompletionParams
            {
                TextDocument = id,
                Position = new Position(dotPos.Line, dotPos.Character + "Width.".Length),
            });
            Assert.NotNull(completion);
            Assert.NotEmpty(completion.Items);
            Assert.DoesNotContain(completion.Items, i => i.Kind == CompletionItemKind.Keyword);
        }
        finally
        {
            try { Directory.Delete(rootDir, recursive: true); } catch { }
        }
    }

    private static Task ChangeAsync(LspServer server, DocumentUri uri, string text, int version)
        => server.DidChangeAsync(new DidChangeTextDocumentParams
        {
            TextDocument = new VersionedTextDocumentIdentifier { Uri = uri, Version = version },
            ContentChanges = [new TextDocumentContentChangeEvent { Text = text }],
        });
}
