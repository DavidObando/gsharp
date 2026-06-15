// <copyright file="CrossAssemblyNavigationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Regression coverage for cross-assembly Go-to-Definition (Tier 2, portable-PDB
/// navigation) and for CodeLens in a real project context. These exercise the exact
/// "navigate to a C# type/member in the same solution" and "reference lenses" features.
/// They use the repo's own C#-compiled <c>GSharp.Core.dll</c> (with its sidecar PDB and
/// <c>.cs</c> sources on disk) as a faithful stand-in for a sibling C# project.
/// </summary>
public class CrossAssemblyNavigationTests
{
    [Fact]
    public void Tier2_PdbNavigation_ResolvesCSharpCompiledTypeToSource()
    {
        var type = typeof(GSharp.Core.CodeAnalysis.Symbols.PropertySymbol);
        var asmPath = type.Assembly.Location;
        if (!HasPortablePdb(asmPath))
        {
            return; // No PDB in this build configuration — navigation is intentionally a no-op.
        }

        var ok = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out var loc);

        Assert.True(ok, "Tier-2 PDB navigation should resolve a C#-compiled type to source.");
        Assert.Contains("PropertySymbol", loc.FilePath);
    }

    [Fact]
    public void GoToDefinition_OnCSharpTypeReferencedFromGsharp_NavigatesToSource()
    {
        // The "C# type in the same solution" scenario: a G# project references a C#
        // assembly and uses one of its types; go-to-definition lands in the C# source.
        var corePath = typeof(GSharp.Core.CodeAnalysis.Text.SourceText).Assembly.Location;
        if (!HasPortablePdb(corePath))
        {
            return;
        }

        const string source = "import GSharp.Core.CodeAnalysis.Text\n\nfunc F(s SourceText) {\n}\n";

        var project = new ProjectState(Path.Combine(Path.GetTempPath(), "e2e", "e2e.gsproj"));
        project.References = new[] { corePath };
        project.UpdateFile("/tmp/e2e/a.gs", source);
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(source, "/tmp/e2e/a.gs"));
        var lines = Enumerable.Range(0, source.Length).Where(i => source[i] == '\n').ToList();
        var content = new DocumentContent(tree, lines, project, new WorkspaceState());
        var uri = DocumentUri.From("file:///tmp/e2e/a.gs");

        var loc = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "SourceText", 0));

        Assert.NotNull(loc);
        Assert.Contains("SourceText", loc.Uri.GetFileSystemPath());
    }

    [Fact]
    public async Task CodeLens_InProjectContext_ReturnsReferenceLenses()
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gscl_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);
        try
        {
            File.WriteAllText(
                Path.Combine(projDir, "Demo.gsproj"),
                "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

            const string source = "package Demo\n\nclass Rect {\n    prop Width int32\n    prop Height int32\n    func Area() int32 { return Width * Height }\n}\n\nclass User {\n    func Make() Rect { return Rect() }\n}\n";
            var gsPath = Path.Combine(projDir, "Rect.gs");
            File.WriteAllText(gsPath, source);

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, rootDir);
            var server = new LspServer(new DocumentContentService(), workspace);
            var uri = DocumentUri.FromFileSystemPath(gsPath);
            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem { Uri = uri, Text = source },
            });

            var lenses = await server.CodeLensAsync(new CodeLensParams { TextDocument = new TextDocumentIdentifier { Uri = uri } });

            Assert.NotNull(lenses);
            Assert.NotEmpty(lenses);
            // The Rect class declaration carries a reference lens (referenced by User.Make).
            Assert.Contains(lenses, l => l.Command != null && l.Command.Title.Contains("reference"));
        }
        finally
        {
            try { Directory.Delete(rootDir, recursive: true); } catch { }
        }
    }

    private static bool HasPortablePdb(string assemblyPath)
        => !string.IsNullOrEmpty(assemblyPath) && File.Exists(Path.ChangeExtension(assemblyPath, ".pdb"));
}
