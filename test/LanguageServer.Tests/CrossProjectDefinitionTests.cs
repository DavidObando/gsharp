// <copyright file="CrossProjectDefinitionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using System.Reflection;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class CrossProjectDefinitionTests
{
    /// <summary>
    /// Tier 1 — Sibling G# project: when a workspace owns a sibling project
    /// whose AssemblyName matches the assembly an <see cref="System.Type"/>
    /// was loaded from, the resolver should walk that project's syntax trees
    /// and return the in-source identifier token.
    /// </summary>
    [Fact]
    public void Tier1_SiblingGsharpProject_TypeNavigatesToStructDeclaration()
    {
        // Use a real loaded CLR type so MetadataToken / Assembly.Location are real.
        // Pretend the sibling G# project produced the assembly that hosts this type
        // and contains a G# struct with the same Name + Namespace.
        var target = typeof(System.Text.StringBuilder);
        var siblingProjectName = System.IO.Path.GetFileNameWithoutExtension(target.Assembly.Location);

        var workspace = new WorkspaceState();
        var sibling = workspace.AddProject($"/test/{siblingProjectName}/{siblingProjectName}.gsproj");
        sibling.AssemblyName = siblingProjectName;
        sibling.UpdateFile(
            $"/test/{siblingProjectName}/StringBuilder.gs",
            "package System.Text\n\nclass StringBuilder { }\n");

        var resolved = CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var location);

        Assert.True(resolved, $"Expected sibling project lookup to succeed for {target.FullName}");
        Assert.NotNull(location);
        Assert.Contains("StringBuilder.gs", location.Uri.GetFileSystemPath());
    }

    /// <summary>
    /// Tier 1 — Sibling G# project: a method on a sibling type navigates to
    /// the matching G# method declaration's identifier (matched by name with
    /// arity-based overload resolution).
    /// </summary>
    [Fact]
    public void Tier1_SiblingGsharpProject_MethodNavigatesToMethodDeclaration()
    {
        // typeof(StringBuilder).GetMethod("Clear") — a zero-arity method we can match by name+arity.
        var target = typeof(System.Text.StringBuilder).GetMethod(nameof(System.Text.StringBuilder.Clear));
        Assert.NotNull(target);

        var siblingProjectName = System.IO.Path.GetFileNameWithoutExtension(target.Module.Assembly.Location);

        var workspace = new WorkspaceState();
        var sibling = workspace.AddProject($"/test/{siblingProjectName}/{siblingProjectName}.gsproj");
        sibling.AssemblyName = siblingProjectName;
        sibling.UpdateFile(
            $"/test/{siblingProjectName}/StringBuilder.gs",
            "package System.Text\n\nclass StringBuilder {\n    func Clear() { }\n}\n");

        var resolved = CrossAssemblyDefinitionResolver.TryResolveMethod(workspace, target, out var location);

        Assert.True(resolved);
        Assert.NotNull(location);
        Assert.Contains("StringBuilder.gs", location.Uri.GetFileSystemPath());

        // The Identifier of the Clear() method lives on line 3 (0-based) of the source above
        // (line 0 = "package System.Text", 1 = "", 2 = "class StringBuilder {", 3 = "    func Clear() { }").
        Assert.Equal(3, location.Range.Start.Line);
    }

    /// <summary>
    /// Tier 1 — Sibling lookup: the resolver should resolve types whose CLR
    /// namespace differs from the project's package by matching on namespace +
    /// simple name, not by full name.
    /// </summary>
    [Fact]
    public void Tier1_SiblingGsharpProject_EmptyNamespaceStructMatchesByName()
    {
        // System.Object has Namespace="System" — test that empty package on G# side does not match.
        var target = typeof(object);
        var siblingProjectName = System.IO.Path.GetFileNameWithoutExtension(target.Assembly.Location);

        var workspace = new WorkspaceState();
        var sibling = workspace.AddProject($"/test/{siblingProjectName}/{siblingProjectName}.gsproj");
        sibling.AssemblyName = siblingProjectName;
        // Note: no `package` statement → G# struct's PackageName is empty, won't match "System".
        sibling.UpdateFile($"/test/{siblingProjectName}/Object.gs", "class Object { }\n");

        var resolved = CrossAssemblyDefinitionResolver.TryResolveType(workspace, target, out var location);

        Assert.False(resolved);
        Assert.Null(location);
    }

    /// <summary>
    /// Workspace lookup: matching is by basename and case-insensitive (Windows path semantics).
    /// </summary>
    [Fact]
    public void Workspace_TryGetProjectByOutputAssembly_MatchesByBasename()
    {
        var workspace = new WorkspaceState();
        var lib = workspace.AddProject("/test/lib/lib.gsproj");
        lib.AssemblyName = "MyLib";

        Assert.True(workspace.TryGetProjectByOutputAssembly(
            "/some/where/obj/Debug/net8.0/MyLib.dll",
            out var found));
        Assert.Same(lib, found);

        Assert.True(workspace.TryGetProjectByOutputAssembly(
            "/some/where/obj/Debug/net8.0/refint/mylib.dll",
            out found));
        Assert.Same(lib, found);
    }

    [Fact]
    public void Workspace_TryGetProjectByOutputAssembly_ReturnsFalseForUnknown()
    {
        var workspace = new WorkspaceState();
        var lib = workspace.AddProject("/test/lib/lib.gsproj");
        lib.AssemblyName = "MyLib";

        Assert.False(workspace.TryGetProjectByOutputAssembly(
            "/some/where/Other.dll",
            out var found));
        Assert.Null(found);
    }

    [Fact]
    public void Workspace_TryGetProjectByOutputAssembly_IgnoresProjectsWithoutAssemblyName()
    {
        var workspace = new WorkspaceState();
        // Project added without an AssemblyName (typical for the implicit project
        // or tests that don't go through discovery).
        workspace.AddProject("/test/loose/loose.gsproj");

        Assert.False(workspace.TryGetProjectByOutputAssembly("/elsewhere/Anything.dll", out _));
    }

    /// <summary>
    /// Tier 2 — PDB-based: open a real portable PDB (the test assembly's own
    /// sidecar) and resolve a known method token to a source file/line.
    /// </summary>
    [Fact]
    public void Tier2_PdbSourceLocator_ResolvesMethodFromSidecarPdb()
    {
        // Pick a stable method on this very test class. The compiler emits a
        // sequence point on its opening brace, so we can assert on file path
        // and a reasonable line range.
        var method = typeof(CrossProjectDefinitionTests).GetMethod(nameof(MarkerMethod), BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(method);

        var assemblyPath = typeof(CrossProjectDefinitionTests).Assembly.Location;

        var resolved = PdbSourceLocator.TryGetMethodSourceLocation(assemblyPath, method.MetadataToken, out var location);

        Assert.True(resolved, $"Expected to read sidecar PDB next to {assemblyPath}");
        Assert.EndsWith("CrossProjectDefinitionTests.cs", location.FilePath);
        Assert.True(location.StartLine > 0, "Expected a 1-based source line");
    }

    [Fact]
    public void Tier2_PdbSourceLocator_ReturnsFalseForUnknownAssembly()
    {
        Assert.False(PdbSourceLocator.TryGetMethodSourceLocation(
            "/does/not/exist/Phantom.dll",
            methodMetadataToken: 0x06000001,
            out var location));
        Assert.Equal(default, location);
    }

    [Fact]
    public void Tier2_PdbSourceLocator_ResolvesTypeFromSidecarPdb()
    {
        var type = typeof(CrossProjectDefinitionTests);
        var assemblyPath = type.Assembly.Location;

        var resolved = PdbSourceLocator.TryGetTypeSourceLocation(assemblyPath, type.MetadataToken, out var location);

        Assert.True(resolved);
        Assert.EndsWith("CrossProjectDefinitionTests.cs", location.FilePath);
    }

    /// <summary>
    /// CrossAssemblyDefinitionResolver — Tier 2 fallback: when no sibling
    /// project owns the assembly the resolver should still find a Location via
    /// the PDB.
    /// </summary>
    [Fact]
    public void CrossAssemblyResolver_FallsBackToPdbWhenNoSiblingMatches()
    {
        var method = typeof(CrossProjectDefinitionTests).GetMethod(nameof(MarkerMethod), BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(method);

        // Workspace with an unrelated sibling project — won't match by basename.
        var workspace = new WorkspaceState();
        var unrelated = workspace.AddProject("/test/unrelated/unrelated.gsproj");
        unrelated.AssemblyName = "Unrelated";

        var resolved = CrossAssemblyDefinitionResolver.TryResolveMethod(workspace, method, out var location);

        Assert.True(resolved);
        Assert.NotNull(location);
        Assert.Contains("CrossProjectDefinitionTests.cs", location.Uri.GetFileSystemPath());
    }

    /// <summary>
    /// Integration — DefinitionComputer end-to-end: a consumer file references
    /// a struct defined in a sibling G# project. ResolveSymbol returns null for
    /// the cross-project name (it isn't in the consumer's compilation), and
    /// the new ImportedClrMember fallback path should kick in. Since this
    /// scenario requires the sibling DLL to be loaded into a
    /// MetadataLoadContext (which only happens at LSP runtime once the project
    /// is built), the unit-test layer instead exercises the resolver directly;
    /// the LSP pipeline is verified via the e2e projectref-e2e harness.
    /// </summary>
    [Fact]
    public void DefinitionComputer_NoWorkspace_StillResolvesSameFileSymbols()
    {
        // Sanity: the changes did not break the original same-file Go-to-Definition path.
        const string source = "func add(a int32, b int32) int32 { return a + b }\nlet result = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "add", 1));

        Assert.NotNull(location);
        Assert.Equal(0, location.Range.Start.Line);
        Assert.Equal(5, location.Range.Start.Character);
    }

    /// <summary>
    /// End-to-end integration test for Tier 1: build a real G# Lib DLL on
    /// disk, set up a workspace as <see cref="WorkspaceInitializer"/> would,
    /// and drive <see cref="DefinitionComputer.ComputeDefinition"/> through the
    /// full ResolveSymbol → ImportedClassSymbol → CrossAssemblyDefinitionResolver
    /// pipeline. Verifies that F12 on a sibling-project type in App.gs lands
    /// inside Lib.gs.
    /// </summary>
    [Fact]
    public void DefinitionComputer_EndToEnd_NavigatesAcrossGsharpProjects()
    {
        var tempDir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"gsharp-xprj-{System.Guid.NewGuid():N}");
        System.IO.Directory.CreateDirectory(tempDir);
        try
        {
            // 1. Compile a real Lib DLL from a real G# source file on disk.
            var libDir = System.IO.Path.Combine(tempDir, "Lib");
            System.IO.Directory.CreateDirectory(libDir);
            var libSourcePath = System.IO.Path.Combine(libDir, "Greeter.gs");
            const string LibSource =
                "package XProjTestLib\n" +
                "class Greeter(Name string) {\n" +
                "    func Greet() string {\n" +
                "        return \"hi\"\n" +
                "    }\n" +
                "}\n";
            System.IO.File.WriteAllText(libSourcePath, LibSource);

            var libDllPath = System.IO.Path.Combine(libDir, "XProjTestLib.dll");
            var libPdbPath = System.IO.Path.Combine(libDir, "XProjTestLib.pdb");

            var libCompilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(
                GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.Default(),
                GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                    GSharp.Core.CodeAnalysis.Text.SourceText.From(LibSource, libSourcePath)));
            libCompilation.DebugInformation = new GSharp.Core.CodeAnalysis.Emit.DebugInformationOptions
            {
                Format = GSharp.Core.CodeAnalysis.Emit.DebugInformationFormat.Portable,
            };
            using (var peStream = new System.IO.FileStream(libDllPath, System.IO.FileMode.Create))
            using (var pdbStream = new System.IO.FileStream(libPdbPath, System.IO.FileMode.Create))
            {
                var libResult = libCompilation.Emit(peStream, pdbStream, refStream: null, assemblyName: "XProjTestLib");
                Assert.True(libResult.Success, "Lib should compile: " + string.Join(", ", libResult.Diagnostics.Select(d => d.Message)));
            }

            // 2. App.gs source — a consumer that imports the lib and uses Greeter.
            var appDir = System.IO.Path.Combine(tempDir, "App");
            System.IO.Directory.CreateDirectory(appDir);
            var appSourcePath = System.IO.Path.Combine(appDir, "Program.gs");
            const string AppSource =
                "package XProjTestApp\n" +
                "import System\n" +
                "import XProjTestLib\n" +
                "var greeter = Greeter(\"world\")\n" +
                "Console.WriteLine(greeter.Greet())\n";
            System.IO.File.WriteAllText(appSourcePath, AppSource);

            // 3. Workspace state — App project references Lib via the .dll path.
            var workspace = new WorkspaceState();

            var libProject = workspace.AddProject(System.IO.Path.Combine(libDir, "XProjTestLib.gsproj"));
            libProject.AssemblyName = "XProjTestLib";
            libProject.AddFileFromDisk(libSourcePath);

            var appProject = workspace.AddProject(System.IO.Path.Combine(appDir, "XProjTestApp.gsproj"));
            appProject.AssemblyName = "XProjTestApp";
            appProject.References = new[] { libDllPath };
            appProject.AddFileFromDisk(appSourcePath);
            workspace.RegisterFile(appSourcePath, appProject);

            // 4. DocumentContent for App.gs as the LSP would produce after didOpen.
            var lineBreaks = new System.Collections.Generic.List<int>();
            for (var i = 0; i < AppSource.Length; i++)
            {
                if (AppSource[i] == '\n')
                {
                    lineBreaks.Add(i);
                }
            }

            var appContent = new DocumentContent(
                appProject.GetCompilation().SyntaxTrees.First(),
                lineBreaks,
                appProject,
                workspace);

            // 5. Cursor on `Greeter` in `var greeter = Greeter("world")` (the call).
            var uri = DocumentUri.FromFileSystemPath(appSourcePath);
            var position = LanguageServerTestHelpers.PositionOf(AppSource, "Greeter", occurrence: 0);

            var location = DefinitionComputer.ComputeDefinition(uri, appContent, position);

            // 6. Should jump into Lib's Greeter.gs.
            Assert.NotNull(location);
            Assert.EndsWith("Greeter.gs", location.Uri.GetFileSystemPath());
        }
        finally
        {
            try
            {
                System.IO.Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; the test runner's temp area is fine if we leak on Windows file-lock.
            }
        }
    }

    /// <summary>
    /// End-to-end integration test for Tier 2: same setup as the Tier 1 test,
    /// but the App's workspace has NO sibling project for the Lib's assembly,
    /// so the resolver must fall through to PDB-based navigation.
    /// </summary>
    [Fact]
    public void DefinitionComputer_EndToEnd_PdbFallback_NavigatesWithoutSiblingProject()
    {
        var tempDir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"gsharp-xprj-pdb-{System.Guid.NewGuid():N}");
        System.IO.Directory.CreateDirectory(tempDir);
        try
        {
            var libDir = System.IO.Path.Combine(tempDir, "Lib");
            System.IO.Directory.CreateDirectory(libDir);
            var libSourcePath = System.IO.Path.Combine(libDir, "Greeter.gs");
            const string LibSource =
                "package XProjPdbLib\n" +
                "class Greeter(Name string) {\n" +
                "    func Greet() string {\n" +
                "        return \"hi\"\n" +
                "    }\n" +
                "}\n";
            System.IO.File.WriteAllText(libSourcePath, LibSource);

            var libDllPath = System.IO.Path.Combine(libDir, "XProjPdbLib.dll");
            var libPdbPath = System.IO.Path.Combine(libDir, "XProjPdbLib.pdb");

            var libCompilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(
                GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.Default(),
                GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                    GSharp.Core.CodeAnalysis.Text.SourceText.From(LibSource, libSourcePath)));
            libCompilation.DebugInformation = new GSharp.Core.CodeAnalysis.Emit.DebugInformationOptions
            {
                Format = GSharp.Core.CodeAnalysis.Emit.DebugInformationFormat.Portable,
            };
            using (var peStream = new System.IO.FileStream(libDllPath, System.IO.FileMode.Create))
            using (var pdbStream = new System.IO.FileStream(libPdbPath, System.IO.FileMode.Create))
            {
                var libResult = libCompilation.Emit(peStream, pdbStream, refStream: null, assemblyName: "XProjPdbLib");
                Assert.True(libResult.Success);
            }

            var appDir = System.IO.Path.Combine(tempDir, "App");
            System.IO.Directory.CreateDirectory(appDir);
            var appSourcePath = System.IO.Path.Combine(appDir, "Program.gs");
            const string AppSource =
                "package XProjPdbApp\n" +
                "import System\n" +
                "import XProjPdbLib\n" +
                "var greeter = Greeter(\"world\")\n" +
                "Console.WriteLine(greeter.Greet())\n";
            System.IO.File.WriteAllText(appSourcePath, AppSource);

            // Workspace has only the App project; Lib is NOT registered as a sibling.
            var workspace = new WorkspaceState();
            var appProject = workspace.AddProject(System.IO.Path.Combine(appDir, "XProjPdbApp.gsproj"));
            appProject.AssemblyName = "XProjPdbApp";
            appProject.References = new[] { libDllPath };
            appProject.AddFileFromDisk(appSourcePath);
            workspace.RegisterFile(appSourcePath, appProject);

            var lineBreaks = new System.Collections.Generic.List<int>();
            for (var i = 0; i < AppSource.Length; i++)
            {
                if (AppSource[i] == '\n')
                {
                    lineBreaks.Add(i);
                }
            }

            var appContent = new DocumentContent(
                appProject.GetCompilation().SyntaxTrees.First(),
                lineBreaks,
                appProject,
                workspace);

            var uri = DocumentUri.FromFileSystemPath(appSourcePath);
            var position = LanguageServerTestHelpers.PositionOf(AppSource, "Greeter", occurrence: 0);

            var location = DefinitionComputer.ComputeDefinition(uri, appContent, position);

            // PDB carries the source path from compile time → should land in Greeter.gs.
            Assert.NotNull(location);
            Assert.EndsWith("Greeter.gs", location.Uri.GetFileSystemPath());
        }
        finally
        {
            try
            {
                System.IO.Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup.
            }
        }
    }

#pragma warning disable CA1822 // Intentionally instance method so the compiler emits a normal method body with sequence points.
    private void MarkerMethod()
    {
        // PDB sequence-point anchor for Tier2_PdbSourceLocator_ResolvesMethodFromSidecarPdb.
        System.GC.KeepAlive(this);
    }
#pragma warning restore CA1822
}
