// <copyright file="CrossFileHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class CrossFileHandlerTests
{
    [Fact]
    public void Definition_CrossFile_JumpsToOtherFile()
    {
        // File 1 defines a function, file 2 calls it
        var project = new ProjectState("/test/app.gsproj");
        project.UpdateFile("/test/greeter.gs", "func greet() string { return \"hi\" }\n");
        project.UpdateFile("/test/main.gs", "let msg = greet()\n");

        var content = ContentWithProject(project, "/test/main.gs");
        var callerUri = DocumentUri.From("file:///test/main.gs");

        var location = DefinitionComputer.ComputeDefinition(callerUri, content, new Position(0, 10));

        Assert.NotNull(location);
        // Should navigate to greeter.gs where the function is declared
        Assert.Contains("greeter.gs", location.Uri.GetFileSystemPath());
    }

    [Fact]
    public void References_CrossFile_FindsAllUsages()
    {
        var project = new ProjectState("/test/app.gsproj");
        project.UpdateFile("/test/lib.gs", "func helper() int32 { return 42 }\n");
        project.UpdateFile("/test/main.gs", "let a = helper()\nlet b = helper()\n");

        var content = ContentWithProject(project, "/test/lib.gs");
        var libUri = DocumentUri.From("file:///test/lib.gs");

        // Cursor on "helper" in lib.gs definition
        var locations = ReferencesComputer.ComputeReferences(libUri, content, new Position(0, 5), includeDeclaration: true);

        // Should find the declaration + 2 usages in main.gs = 3 total
        Assert.True(locations.Count >= 3, $"Expected at least 3 references, got {locations.Count}");
    }

    [Fact]
    public void Rename_CrossFile_ProducesMultiFileEdit()
    {
        var project = new ProjectState("/test/app.gsproj");
        project.UpdateFile("/test/lib.gs", "func oldName() int32 { return 1 }\n");
        project.UpdateFile("/test/main.gs", "let val = oldName()\n");

        var content = ContentWithProject(project, "/test/lib.gs");
        var libUri = DocumentUri.From("file:///test/lib.gs");

        var edit = RenameComputer.ComputeRename(libUri, content, new Position(0, 5), "newName");

        Assert.NotNull(edit);
        // Should produce edits spanning multiple files
        Assert.True(edit.Changes.Count >= 2, $"Expected edits in at least 2 files, got {edit.Changes.Count}");
    }

    [Fact]
    public void Completion_CrossFile_IncludesSymbolsFromOtherFiles()
    {
        var project = new ProjectState("/test/app.gsproj");
        project.UpdateFile("/test/lib.gs", "func helper() int32 { return 42 }\n");
        project.UpdateFile("/test/main.gs", "let x = 1\n");

        var content = ContentWithProject(project, "/test/main.gs");

        var items = CompletionComputer.ComputeCompletions(content, new Position(0, 0));

        // Should include "helper" from lib.gs
        Assert.Contains(items, i => i.Label == "helper");
    }

    [Fact]
    public void Hover_CrossFile_ResolvesSymbolFromOtherFile()
    {
        var project = new ProjectState("/test/app.gsproj");
        project.UpdateFile("/test/lib.gs", "func compute(a int32, b int32) int32 { return a + b }\n");
        project.UpdateFile("/test/main.gs", "let result = compute(1, 2)\n");

        var content = ContentWithProject(project, "/test/main.gs");

        // Cursor on "compute" in main.gs
        var hover = HoverComputer.ComputeHover(content, new Position(0, 13));

        Assert.NotNull(hover);
        Assert.Contains("compute", hover.Contents.MarkupContent.Value);
    }

    [Fact]
    public void SignatureHelp_CrossFile_ResolvesFromOtherFile()
    {
        var project = new ProjectState("/test/app.gsproj");
        project.UpdateFile("/test/lib.gs", "func add(a int32, b int32) int32 { return a + b }\n");
        project.UpdateFile("/test/main.gs", "let result = add(1, 2)\n");

        var content = ContentWithProject(project, "/test/main.gs");

        // Cursor inside the parens of add(1, 2) — position after the '('
        var sigHelp = SignatureHelpComputer.ComputeSignatureHelp(content, new Position(0, 17));

        Assert.NotNull(sigHelp);
        Assert.NotEmpty(sigHelp.Signatures);
        Assert.Contains("add", sigHelp.Signatures.First().Label);
    }

    private static DocumentContent ContentWithProject(ProjectState project, string filePath)
    {
        project.TryGetSyntaxTree(filePath, out var tree);
        var source = tree.Text.ToString();
        var lines = new System.Collections.Generic.List<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '\n')
            {
                lines.Add(i);
            }
        }

        return new DocumentContent(tree, lines, project);
    }
}
