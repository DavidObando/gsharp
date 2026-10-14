// <copyright file="CrossFileHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.Collections.Generic
import System.Linq
import Xunit

open class CrossFileHandlerTests {
    @Fact
    func Definition_CrossFile_JumpsToOtherFile() {
        // File 1 defines a function, file 2 calls it
        let project = ProjectState("/test/app.gsproj")
        project.UpdateFile("/test/greeter.gs", "func greet() string { return \"hi\" }\n")
        project.UpdateFile("/test/main.gs", "let msg = greet()\n")
        let content = ContentWithProject(project, "/test/main.gs")
        let callerUri = DocumentUri.From("file:///test/main.gs")!!
        let location Location? = DefinitionComputer.ComputeDefinition(callerUri, content, Position(0, 10))
        Assert.NotNull(location)
        // Should navigate to greeter.gs where the function is declared
        Assert.Contains("greeter.gs", location!!.Uri!!.GetFileSystemPath())
    }

    @Fact
    func References_CrossFile_FindsAllUsages() {
        let project = ProjectState("/test/app.gsproj")
        project.UpdateFile("/test/lib.gs", "func helper() int32 { return 42 }\n")
        project.UpdateFile("/test/main.gs", `let a = helper()
let b = helper()
`)
        let content = ContentWithProject(project, "/test/lib.gs")
        let libUri = DocumentUri.From("file:///test/lib.gs")!!
        // Cursor on "helper" in lib.gs definition
        let locations = ReferencesComputer.ComputeReferences(libUri, content, Position(0, 5), includeDeclaration: true)
        // Should find the declaration + 2 usages in main.gs = 3 total
        Assert.True(locations.Count >= 3, "Expected at least 3 references, got ${locations.Count}")
    }

    @Fact
    func Rename_CrossFile_ProducesMultiFileEdit() {
        let project = ProjectState("/test/app.gsproj")
        project.UpdateFile("/test/lib.gs", "func oldName() int32 { return 1 }\n")
        project.UpdateFile("/test/main.gs", "let val = oldName()\n")
        let content = ContentWithProject(project, "/test/lib.gs")
        let libUri = DocumentUri.From("file:///test/lib.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(libUri, content, Position(0, 5), "newName")
        Assert.NotNull(edit)
        // Should produce edits spanning multiple files
        Assert.True(edit!!.Changes.Count >= 2, "Expected edits in at least 2 files, got ${edit!!.Changes.Count}")
    }

    @Fact
    func Completion_CrossFile_IncludesSymbolsFromOtherFiles() {
        let project = ProjectState("/test/app.gsproj")
        project.UpdateFile("/test/lib.gs", "func helper() int32 { return 42 }\n")
        project.UpdateFile("/test/main.gs", "let x = 1\n")
        let content = ContentWithProject(project, "/test/main.gs")
        let items = CompletionComputer.ComputeCompletions(content, Position(0, 0))
        // Should include "helper" from lib.gs
        Assert.Contains(items, (i CompletionItem) -> i.Label == "helper")
    }

    @Fact
    func Hover_CrossFile_ResolvesSymbolFromOtherFile() {
        let project = ProjectState("/test/app.gsproj")
        project.UpdateFile("/test/lib.gs", "func compute(a int32, b int32) int32 { return a + b }\n")
        project.UpdateFile("/test/main.gs", "let result = compute(1, 2)\n")
        let content = ContentWithProject(project, "/test/main.gs")
        // Cursor on "compute" in main.gs
        let hover Hover? = HoverComputer.ComputeHover(content, Position(0, 13))
        Assert.NotNull(hover)
        Assert.Contains("compute", hover!!.Contents.MarkupContent.Value)
    }

    @Fact
    func SignatureHelp_CrossFile_ResolvesFromOtherFile() {
        let project = ProjectState("/test/app.gsproj")
        project.UpdateFile("/test/lib.gs", "func add(a int32, b int32) int32 { return a + b }\n")
        project.UpdateFile("/test/main.gs", "let result = add(1, 2)\n")
        let content = ContentWithProject(project, "/test/main.gs")
        // Cursor inside the parens of add(1, 2) — position after the '('
        let sigHelp SignatureHelp? = SignatureHelpComputer.ComputeSignatureHelp(content, Position(0, 17))
        Assert.NotNull(sigHelp)
        Assert.NotEmpty(sigHelp!!.Signatures)
        Assert.Contains("add", sigHelp!!.Signatures.First().Label)
    }

    shared {
        private func ContentWithProject(project ProjectState, filePath string) DocumentContent {
            project.TryGetSyntaxTree(filePath, out var tree)
            let source = tree.Text.ToString()
            let lines = List[int32]()
            for var i = 0; i < source.Length; i++ {
                if source[i] == '\n' {
                    lines.Add(i)
                }
            }
            return DocumentContent(tree, lines, project)
        }
    }
}
