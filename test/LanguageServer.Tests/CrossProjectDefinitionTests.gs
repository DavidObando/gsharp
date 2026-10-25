// <copyright file="CrossProjectDefinitionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import System.Linq
import System.Reflection
import GSharp.LanguageServer.Protocol
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import System
import System.Collections.Generic
import System.IO
import System.Text

open class CrossProjectDefinitionTests {
    /// Tier 1 — Sibling G# project: when a workspace owns a sibling project
    /// whose AssemblyName matches the assembly an (cref:System.Type)
    /// was loaded from, the resolver should walk that project's syntax trees
    /// and return the in-source identifier token.
    @Fact
    func Tier1_SiblingGsharpProject_TypeNavigatesToStructDeclaration() {
        // Use a real loaded CLR type so MetadataToken / Assembly.Location are real.
        // Pretend the sibling G# project produced the assembly that hosts this type
        // and contains a G# struct with the same Name + Namespace.
        let target = typeof(StringBuilder)
        let siblingProjectName = Path.GetFileNameWithoutExtension(target.Assembly.Location)
        let workspace = WorkspaceState()
        let sibling = workspace.AddProject("/test/$siblingProjectName/$siblingProjectName.gsproj")
        sibling.AssemblyName = siblingProjectName
        sibling.UpdateFile("/test/$siblingProjectName/StringBuilder.gs", `package System.Text

class StringBuilder { }
`)
        let resolved = CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var location)
        Assert.True(resolved, "Expected sibling project lookup to succeed for ${target.FullName}")
        Assert.NotNull(location)
        Assert.Contains("StringBuilder.gs", location.Uri!!.GetFileSystemPath())
    }

    /// A generic delegate navigates to the declaration of its own package, and after a body-only edit
    /// that shifts text, to the current position of that declaration.
    @Fact
    func Tier1_SiblingGsharpProject_GenericDelegateKeepsPackageAndSurvivesABodyEdit() {
        let target = typeof(Action[int32])
        let siblingProjectName = Path.GetFileNameWithoutExtension(target.Assembly.Location)
        let workspace = WorkspaceState()
        let sibling = workspace.AddProject("/test/$siblingProjectName/$siblingProjectName.gsproj")
        sibling.AssemblyName = siblingProjectName
        let otherPath = "/test/$siblingProjectName/Other.gs"
        let systemPath = "/test/$siblingProjectName/Delegates.gs"
        sibling.UpdateFile(otherPath, `package Other

delegate Action[T](value T);
`)
        let systemText = `package System

func Body() int32 {
    return 1
}

delegate Action[T](value T);
`
        sibling.UpdateFile(systemPath, systemText)
        let before = sibling.GetCompilation()
        let _ = before.GlobalScope
        Assert.True(CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var first))
        Assert.Contains("Delegates.gs", first.Uri!!.GetFileSystemPath())
        Assert.Equal(6, first.Range.Start.Line)
        sibling.UpdateFile(systemPath, systemText.Replace("return 1", "let x int32 = 1\n    return x"))
        let after = sibling.GetCompilation()
        Assert.Same(before.GlobalScope, after.GlobalScope)
        Assert.True(CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var second))
        Assert.Contains("Delegates.gs", second.Uri!!.GetFileSystemPath())
        Assert.Equal(7, second.Range.Start.Line)
    }

    /// A case-only file rename counts as the same file for the project's incremental reuse, so the
    /// resolver must pair the delegate's original tree with the renamed one the same way.
    @Fact
    func Tier1_SiblingGsharpProject_GenericDelegateSurvivesACaseOnlyPathChange() {
        let target = typeof(Action[int32])
        let siblingProjectName = Path.GetFileNameWithoutExtension(target.Assembly.Location)
        let workspace = WorkspaceState()
        let sibling = workspace.AddProject("/test/$siblingProjectName/$siblingProjectName.gsproj")
        sibling.AssemblyName = siblingProjectName
        let text = `package System

func Body() int32 {
    return 1
}

delegate Action[T](value T);
`
        sibling.UpdateFile("/test/$siblingProjectName/Delegates.gs", text)
        let before = sibling.GetCompilation()
        let _ = before.GlobalScope
        sibling.UpdateFile(
            "/test/$siblingProjectName/DELEGATES.gs",
            text.Replace("return 1", "let x int32 = 1\n    return x")
        )
        let after = sibling.GetCompilation()
        Assert.Same(before.GlobalScope, after.GlobalScope)
        Assert.True(CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var location))
        Assert.EndsWith("DELEGATES.gs", location.Uri!!.GetFileSystemPath())
        Assert.Equal(7, location.Range.Start.Line)
    }

    /// ProjectState keys files by their full path, so `./` and `..` spellings of one file are one file for
    /// reuse; the resolver must pair the delegate's tree with the replacement the same way.
    @Theory
    @InlineData("/./Delegates.gs")
    @InlineData("/sub/../Delegates.gs")
    func Tier1_SiblingGsharpProject_GenericDelegateSurvivesAPathAliasEdit(alias string) {
        let target = typeof(Action[int32])
        let siblingProjectName = Path.GetFileNameWithoutExtension(target.Assembly.Location)
        let workspace = WorkspaceState()
        let sibling = workspace.AddProject("/test/$siblingProjectName/$siblingProjectName.gsproj")
        sibling.AssemblyName = siblingProjectName
        let text = `package System

func Body() int32 {
    return 1
}

delegate Action[T](value T);
`
        sibling.UpdateFile("/test/$siblingProjectName/Delegates.gs", text)
        let before = sibling.GetCompilation()
        let _ = before.GlobalScope
        sibling.UpdateFile("/test/$siblingProjectName$alias", text.Replace("return 1", "let x int32 = 1\n    return x"))
        Assert.Same(before.GlobalScope, sibling.GetCompilation().GlobalScope)
        Assert.True(CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var location))
        Assert.Equal(7, location.Range.Start.Line)
    }

    /// The delegate is the second one of its file. A body-only edit keeps its position among the
    /// file's delegates; an edit that adds a delegate before it is not body-only and binds from scratch.
    @Fact
    func Tier1_SiblingGsharpProject_GenericDelegateAmongSeveralSurvivesBodyAndDeclarationEdits() {
        let target = typeof(Action[int32])
        let siblingProjectName = Path.GetFileNameWithoutExtension(target.Assembly.Location)
        let workspace = WorkspaceState()
        let sibling = workspace.AddProject("/test/$siblingProjectName/$siblingProjectName.gsproj")
        sibling.AssemblyName = siblingProjectName
        let path = "/test/$siblingProjectName/Delegates.gs"
        let text = `package System

func Body() int32 {
    return 1
}

delegate Other(value int32);
delegate Action[T](value T);
`
        sibling.UpdateFile(path, text)
        let before = sibling.GetCompilation()
        let _ = before.GlobalScope
        let bodyEdited = text.Replace("return 1", "let x int32 = 1\n    return x")
        sibling.UpdateFile(path, bodyEdited)
        Assert.Same(before.GlobalScope, sibling.GetCompilation().GlobalScope)
        Assert.True(CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var afterBody))
        Assert.Equal(8, afterBody.Range.Start.Line)
        sibling.UpdateFile(
            path,
            bodyEdited.Replace(
                "delegate Other(value int32);",
                "delegate Other(value int32);\ndelegate Extra(value int32);"
            )
        )
        Assert.NotSame(before.GlobalScope, sibling.GetCompilation().GlobalScope)
        Assert.True(CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var afterAdd))
        Assert.Equal(9, afterAdd.Range.Start.Line)
    }

    /// Tier 1 — Sibling G# project: a method on a sibling type navigates to
    /// the matching G# method declaration's identifier (matched by name with
    /// arity-based overload resolution).
    @Fact
    func Tier1_SiblingGsharpProject_MethodNavigatesToMethodDeclaration() {
        // typeof(StringBuilder).GetMethod("Clear") — a zero-arity method we can match by name+arity.
        let target MethodInfo? = typeof(StringBuilder).GetMethod("Clear")
        Assert.NotNull(target)
        let siblingProjectName = Path.GetFileNameWithoutExtension(target!!.Module.Assembly.Location)
        let workspace = WorkspaceState()
        let sibling = workspace.AddProject("/test/$siblingProjectName/$siblingProjectName.gsproj")
        sibling.AssemblyName = siblingProjectName
        sibling.UpdateFile("/test/$siblingProjectName/StringBuilder.gs", `package System.Text

class StringBuilder {
    func Clear() { }
}
`)
        let resolved = CrossAssemblyDefinitionResolver.TryResolveMethod(workspace, target!!, out var location)
        Assert.True(resolved)
        Assert.NotNull(location)
        Assert.Contains("StringBuilder.gs", location.Uri!!.GetFileSystemPath())
        // The Identifier of the Clear() method lives on line 3 (0-based) of the source above
        // (line 0 = "package System.Text", 1 = "", 2 = "class StringBuilder {", 3 = "    func Clear() { }").
        Assert.Equal(3, location.Range.Start.Line)
    }

    /// Tier 1 — Sibling lookup: the resolver should resolve types whose CLR
    /// namespace differs from the project's package by matching on namespace +
    /// simple name, not by full name.
    @Fact
    func Tier1_SiblingGsharpProject_EmptyNamespaceStructMatchesByName() {
        // System.Object has Namespace="System" — test that empty package on G# side does not match.
        let target = typeof(object)
        let siblingProjectName = Path.GetFileNameWithoutExtension(target.Assembly.Location)
        let workspace = WorkspaceState()
        let sibling = workspace.AddProject("/test/$siblingProjectName/$siblingProjectName.gsproj")
        sibling.AssemblyName = siblingProjectName
        // Note: no `package` statement → G# struct's PackageName is empty, won't match "System".
        sibling.UpdateFile("/test/$siblingProjectName/Object.gs", "class Object { }\n")
        let resolved = CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var location)
        Assert.False(resolved)
        Assert.Null(location)
    }

    /// Workspace lookup: matching is by basename and case-insensitive (Windows path semantics).
    @Fact
    func Workspace_TryGetProjectByOutputAssembly_MatchesByBasename() {
        let workspace = WorkspaceState()
        let lib = workspace.AddProject("/test/lib/lib.gsproj")
        lib.AssemblyName = "MyLib"
        Assert.True(workspace.TryGetProjectByOutputAssembly("/some/where/obj/Debug/net8.0/MyLib.dll", out var found))
        Assert.Same(lib, found)
        Assert.True(workspace.TryGetProjectByOutputAssembly("/some/where/obj/Debug/net8.0/refint/mylib.dll", out found))
        Assert.Same(lib, found)
    }

    @Fact
    func Workspace_TryGetProjectByOutputAssembly_ReturnsFalseForUnknown() {
        let workspace = WorkspaceState()
        let lib = workspace.AddProject("/test/lib/lib.gsproj")
        lib.AssemblyName = "MyLib"
        Assert.False(workspace.TryGetProjectByOutputAssembly("/some/where/Other.dll", out var found))
        Assert.Null(found)
    }

    @Fact
    func Workspace_TryGetProjectByOutputAssembly_IgnoresProjectsWithoutAssemblyName() {
        let workspace = WorkspaceState()
        // Project added without an AssemblyName (typical for the implicit project
        // or tests that don't go through discovery).
        workspace.AddProject("/test/loose/loose.gsproj")
        Assert.False(workspace.TryGetProjectByOutputAssembly("/elsewhere/Anything.dll", out _))
    }

    /// Tier 2 — PDB-based: open a real portable PDB (the test assembly's own
    /// sidecar) and resolve a known method token to a source file/line.
    @Fact
    func Tier2_PdbSourceLocator_ResolvesMethodFromSidecarPdb() {
        // Pick a stable method on this very test class. The compiler emits a
        // sequence point on its opening brace, so we can assert on file path
        // and a reasonable line range.
        let method MethodInfo? = typeof(CrossProjectDefinitionTests).GetMethod(
            "MarkerMethod",
            BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(method)
        let assemblyPath = typeof(CrossProjectDefinitionTests).Assembly.Location
        let resolved = PdbSourceLocator.TryGetMethodSourceLocation(
            assemblyPath,
            method!!.MetadataToken,
            out var location
        )
        Assert.True(resolved, "Expected to read sidecar PDB next to $assemblyPath")
        Assert.Equal("CrossProjectDefinitionTests", Path.GetFileNameWithoutExtension(location.FilePath))
        Assert.True(location.StartLine > 0, "Expected a 1-based source line")
    }

    @Fact
    func Tier2_PdbSourceLocator_ReturnsFalseForUnknownAssembly() {
        Assert.False(
            PdbSourceLocator.TryGetMethodSourceLocation(
                "/does/not/exist/Phantom.dll",
                methodMetadataToken: 0x06000001,
                out var location
            )
        )
        Assert.Equal(default(PdbSourceLocator.SourceLocation), location)
    }

    @Fact
    func Tier2_PdbSourceLocator_ResolvesTypeFromSidecarPdb() {
        let type = typeof(CrossProjectDefinitionTests)
        let assemblyPath = type.Assembly.Location
        let resolved = PdbSourceLocator.TryGetTypeSourceLocation(assemblyPath, type.MetadataToken, out var location)
        Assert.True(resolved)
        Assert.Equal("CrossProjectDefinitionTests", Path.GetFileNameWithoutExtension(location.FilePath))
    }

    /// CrossAssemblyDefinitionResolver — Tier 2 fallback: when no sibling
    /// project owns the assembly the resolver should still find a Location via
    /// the PDB.
    @Fact
    func CrossAssemblyResolver_FallsBackToPdbWhenNoSiblingMatches() {
        let method MethodInfo? = typeof(CrossProjectDefinitionTests).GetMethod(
            "MarkerMethod",
            BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(method)
        // Workspace with an unrelated sibling project — won't match by basename.
        let workspace = WorkspaceState()
        let unrelated = workspace.AddProject("/test/unrelated/unrelated.gsproj")
        unrelated.AssemblyName = "Unrelated"
        let resolved = CrossAssemblyDefinitionResolver.TryResolveMethod(workspace, method!!, out var location)
        Assert.True(resolved)
        Assert.NotNull(location)
        Assert.Equal(
            "CrossProjectDefinitionTests",
            Path.GetFileNameWithoutExtension(location.Uri!!.GetFileSystemPath())
        )
    }

    /// Integration — DefinitionComputer end-to-end: a consumer file references
    /// a struct defined in a sibling G# project. ResolveSymbol returns null for
    /// the cross-project name (it isn't in the consumer's compilation), and
    /// the new ImportedClrMember fallback path should kick in. Since this
    /// scenario requires the sibling DLL to be loaded into a
    /// MetadataLoadContext (which only happens at LSP runtime once the project
    /// is built), the unit-test layer instead exercises the resolver directly;
    /// the LSP pipeline is verified via the e2e projectref-e2e harness.
    @Fact
    func DefinitionComputer_NoWorkspace_StillResolvesSameFileSymbols() {
        // Sanity: the changes did not break the original same-file Go-to-Definition path.
        const source = `func add(a int32, b int32) int32 { return a + b }
let result = add(1, 2)
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")!!
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "add", 1)
        )
        Assert.NotNull(location)
        Assert.Equal(0, location!!.Range.Start.Line)
        Assert.Equal(5, location!!.Range.Start.Character)
    }

    /// End-to-end integration test for Tier 1: build a real G# Lib DLL on
    /// disk, set up a workspace as (cref:WorkspaceInitializer) would,
    /// and drive (cref:DefinitionComputer.ComputeDefinition) through the
    /// full ResolveSymbol → ImportedClassSymbol → CrossAssemblyDefinitionResolver
    /// pipeline. Verifies that F12 on a sibling-project type in App.gs lands
    /// inside Lib.gs.
    @Fact
    func DefinitionComputer_EndToEnd_NavigatesAcrossGsharpProjects() {
        let tempDir = Path.Combine(Path.GetTempPath(), "gsharp-xprj-${Guid.NewGuid():N}")
        Directory.CreateDirectory(tempDir)
        try {
            // 1. Compile a real Lib DLL from a real G# source file on disk.
            let libDir = Path.Combine(tempDir, "Lib")
            Directory.CreateDirectory(libDir)
            let libSourcePath = Path.Combine(libDir, "Greeter.gs")
            const LibSource = "package XProjTestLib\n" +
                "class Greeter(Name string) {\n" +
                "    func Greet() string {\n" +
                "        return \"hi\"\n" +
                "    }\n" +
                "}\n"
            File.WriteAllText(libSourcePath, LibSource)
            let libDllPath = Path.Combine(libDir, "XProjTestLib.dll")
            let libPdbPath = Path.Combine(libDir, "XProjTestLib.pdb")
            let libRefDir = Path.Combine(libDir, "ref")
            Directory.CreateDirectory(libRefDir)
            let libRefPath = Path.Combine(libRefDir, "XProjTestLib.dll")
            let libCompilation = Compilation(
                ReferenceResolver.Default(),
                SyntaxTree.Parse(SourceText.From(LibSource, libSourcePath))
            )
            libCompilation.DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
            {
                using let peStream = FileStream(libDllPath, FileMode.Create)
                {
                    using let pdbStream = FileStream(libPdbPath, FileMode.Create)
                    {
                        using let refStream = FileStream(libRefPath, FileMode.Create)
                        let libResult = libCompilation.Emit(
                            peStream,
                            pdbStream,
                            refStream,
                            assemblyName: "XProjTestLib"
                        )
                        Assert.True(
                            libResult.Success,
                            "Lib should compile: " + string.Join(
                                ", ",
                                libResult.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                            )
                        )
                    }
                }
            }
            // 2. App.gs source — a consumer that imports the lib and uses Greeter.
            let appDir = Path.Combine(tempDir, "App")
            Directory.CreateDirectory(appDir)
            let appSourcePath = Path.Combine(appDir, "Program.gs")
            const AppSource = "package XProjTestApp\n" +
                "import System\n" +
                "import XProjTestLib\n" +
                "var greeter = Greeter(\"world\")\n" +
                "Console.WriteLine(greeter.Greet())\n"
            File.WriteAllText(appSourcePath, AppSource)
            // 3. Workspace state — App project references Lib via the .dll path.
            let workspace = WorkspaceState()
            let libProject = workspace.AddProject(Path.Combine(libDir, "XProjTestLib.gsproj"))
            libProject.AssemblyName = "XProjTestLib"
            libProject.AddFileFromDisk(libSourcePath)
            let appProject = workspace.AddProject(Path.Combine(appDir, "XProjTestApp.gsproj"))
            appProject.AssemblyName = "XProjTestApp"
            appProject.References = []string{libRefPath}
            appProject.AddFileFromDisk(appSourcePath)
            workspace.RegisterFile(appSourcePath, appProject)
            // 4. DocumentContent for App.gs as the LSP would produce after didOpen.
            let lineBreaks = List[int32]()
            for var i = 0; i < AppSource.Length; i++ {
                if AppSource[i] == '\n' {
                    lineBreaks.Add(i)
                }
            }
            let appContent = DocumentContent(
                appProject.GetCompilation().SyntaxTrees.First(),
                lineBreaks,
                appProject,
                workspace
            )
            // 5. Cursor on `Greeter` in `var greeter = Greeter("world")` (the call).
            let uri = DocumentUri.FromFileSystemPath(appSourcePath)!!
            let position = LanguageServerTestHelpers.PositionOf(AppSource, "Greeter", occurrence: 0)
            let location Location? = DefinitionComputer.ComputeDefinition(uri, appContent, position)
            // 6. Should jump into Lib's Greeter.gs.
            Assert.NotNull(location)
            Assert.EndsWith("Greeter.gs", location!!.Uri!!.GetFileSystemPath())
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch {
                // Best-effort cleanup; the test runner's temp area is fine if we leak on Windows file-lock.

            }
        }
    }

    /// End-to-end integration test for Tier 2: same setup as the Tier 1 test,
    /// but the App's workspace has NO sibling project for the Lib's assembly,
    /// so the resolver must fall through to PDB-based navigation.
    @Fact
    func DefinitionComputer_EndToEnd_PdbFallback_NavigatesWithoutSiblingProject() {
        let tempDir = Path.Combine(Path.GetTempPath(), "gsharp-xprj-pdb-${Guid.NewGuid():N}")
        Directory.CreateDirectory(tempDir)
        try {
            let libDir = Path.Combine(tempDir, "Lib")
            Directory.CreateDirectory(libDir)
            let libSourcePath = Path.Combine(libDir, "Greeter.gs")
            const LibSource = "package XProjPdbLib\n" +
                "class Greeter(Name string) {\n" +
                "    func Greet() string {\n" +
                "        return \"hi\"\n" +
                "    }\n" +
                "}\n"
            File.WriteAllText(libSourcePath, LibSource)
            let libDllPath = Path.Combine(libDir, "XProjPdbLib.dll")
            let libPdbPath = Path.Combine(libDir, "XProjPdbLib.pdb")
            let libCompilation = Compilation(
                ReferenceResolver.Default(),
                SyntaxTree.Parse(SourceText.From(LibSource, libSourcePath))
            )
            libCompilation.DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
            {
                using let peStream = FileStream(libDllPath, FileMode.Create)
                {
                    using let pdbStream = FileStream(libPdbPath, FileMode.Create)
                    let libResult = libCompilation.Emit(
                        peStream,
                        pdbStream,
                        refStream: nil,
                        assemblyName: "XProjPdbLib"
                    )
                    Assert.True(libResult.Success)
                }
            }
            let appDir = Path.Combine(tempDir, "App")
            Directory.CreateDirectory(appDir)
            let appSourcePath = Path.Combine(appDir, "Program.gs")
            const AppSource = "package XProjPdbApp\n" +
                "import System\n" +
                "import XProjPdbLib\n" +
                "var greeter = Greeter(\"world\")\n" +
                "Console.WriteLine(greeter.Greet())\n"
            File.WriteAllText(appSourcePath, AppSource)
            // Workspace has only the App project; Lib is NOT registered as a sibling.
            let workspace = WorkspaceState()
            let appProject = workspace.AddProject(Path.Combine(appDir, "XProjPdbApp.gsproj"))
            appProject.AssemblyName = "XProjPdbApp"
            appProject.References = []string{libDllPath}
            appProject.AddFileFromDisk(appSourcePath)
            workspace.RegisterFile(appSourcePath, appProject)
            let lineBreaks = List[int32]()
            for var i = 0; i < AppSource.Length; i++ {
                if AppSource[i] == '\n' {
                    lineBreaks.Add(i)
                }
            }
            let appContent = DocumentContent(
                appProject.GetCompilation().SyntaxTrees.First(),
                lineBreaks,
                appProject,
                workspace
            )
            let uri = DocumentUri.FromFileSystemPath(appSourcePath)!!
            let position = LanguageServerTestHelpers.PositionOf(AppSource, "Greeter", occurrence: 0)
            let location Location? = DefinitionComputer.ComputeDefinition(uri, appContent, position)
            // PDB carries the source path from compile time → should land in Greeter.gs.
            Assert.NotNull(location)
            Assert.EndsWith("Greeter.gs", location!!.Uri!!.GetFileSystemPath())
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch {
                // Best-effort cleanup.

            }
        }
    }

    private func MarkerMethod() {
        // PDB sequence-point anchor for Tier2_PdbSourceLocator_ResolvesMethodFromSidecarPdb.
        GC.KeepAlive(this)
    }
}
