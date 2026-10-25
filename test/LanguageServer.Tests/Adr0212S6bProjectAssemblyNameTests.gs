// <copyright file="Adr0212S6bProjectAssemblyNameTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import System
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import Microsoft.CodeAnalysis.CSharp
import Xunit

/// ADR-0212 S6b: `ProjectState` hands its `AssemblyName` to every `Compilation` it builds, so a reference
/// that declares `InternalsVisibleTo` for the project is honoured as `gsc` honours it.
/// Contract (one rule, applied to every compilation the project produces):
///
/// | project `AssemblyName`            | compilation `AssemblyName` | friend `InternalsVisibleTo("App")` |
/// | --------------------------------- | -------------------------- | ---------------------------------- |
/// | `App`                             | `App`                      | internals visible                  |
/// | `Other`                           | `Other`                    | not visible                        |
/// | `app` (case differs)              | `app`                      | not visible (ordinal, as `gsc`)    |
/// | ` App ` (padding)                 | ` App `                    | visible (the comparison trims)     |
/// | `My.App` (dotted)                 | `My.App`                   | visible when declared as `My.App`  |
/// | `null`, empty, whitespace         | unset                      | not visible (no consumer name)     |
/// | `<AssemblyName>A&amp;B</...>`     | `A&B` (discovery decodes)  | visible when declared as `A&B`     |
/// | successor / snapshot / rename     | predecessor's / the new one| follows the project name           |
open class Adr0212S6bProjectAssemblyNameTests {
    @Theory
    @InlineData("App", "App", true)
    @InlineData("Other", "App", false)
    @InlineData("app", "App", false)
    @InlineData(" App ", "App", true)
    @InlineData("My.App", "My.App", true)
    @InlineData("My.App", "App", false)
    @InlineData("", "App", false)
    @InlineData("   ", "App", false)
    func FriendInternals_FollowTheProjectAssemblyName(projectName string?, friend string, accessible bool) {
        using let fixture = Fixture(friend)
        let project = fixture.NewProject(projectName)
        let compilation = project.GetCompilation()
        Assert.Equal(accessible, !HasInternalAccessErrors(compilation))
        if !string.IsNullOrWhiteSpace(projectName) {
            Assert.Equal(projectName, compilation.AssemblyName)
        } else {
            Assert.True(string.IsNullOrWhiteSpace(compilation.AssemblyName))
        }
    }

    @Fact
    func NilAssemblyName_LeavesTheCompilationNameUnset() {
        using let fixture = Fixture("App")
        let compilation = fixture.NewProject(nil).GetCompilation()
        Assert.True(string.IsNullOrWhiteSpace(compilation.AssemblyName))
        Assert.True(HasInternalAccessErrors(compilation))
    }

    @Fact
    func DiscoveredAssemblyName_DecodesXmlEscapesAndReachesTheCompilation() {
        using let fixture = Fixture("A&B")
        let projectPath = Path.Combine(fixture.Directory, "Escaped.gsproj")
        File.WriteAllText(
            projectPath,
            "<Project><PropertyGroup><AssemblyName>A&amp;B</AssemblyName></PropertyGroup></Project>"
        )
        let discovered = ProjectDiscovery.DiscoverProject(projectPath)!!
        Assert.Equal("A&B", discovered.AssemblyName)
        let project = fixture.NewProject(discovered.AssemblyName)
        let compilation = project.GetCompilation()
        Assert.Equal("A&B", compilation.AssemblyName)
        Assert.False(HasInternalAccessErrors(compilation))
    }

    @Fact
    func DiscoveredProjectWithoutAssemblyName_UsesTheProjectFileName() {
        using let fixture = Fixture("Plain")
        let projectPath = Path.Combine(fixture.Directory, "Plain.gsproj")
        File.WriteAllText(projectPath, "<Project><PropertyGroup></PropertyGroup></Project>")
        let discovered = ProjectDiscovery.DiscoverProject(projectPath)!!
        Assert.Equal("Plain", discovered.AssemblyName)
        let compilation = fixture.NewProject(discovered.AssemblyName).GetCompilation()
        Assert.False(HasInternalAccessErrors(compilation))
    }

    @Fact
    func SuccessorCompilations_InheritTheAssemblyName() {
        using let fixture = Fixture("App")
        let project = fixture.NewProject("App")
        let first = project.GetCompilation()
        Assert.False(HasInternalAccessErrors(first))
        // A body edit takes the ReplaceSyntaxTree successor path.
        project.UpdateFile(fixture.SourcePath, Fixture.Source + "\n")
        let successor = project.GetCompilation()
        Assert.NotSame(first, successor)
        Assert.Equal("App", successor.AssemblyName)
        Assert.False(HasInternalAccessErrors(successor))
        // The off-gate snapshot path (clean compilation, different tree) goes through WithReplacedSyntaxTree.
        let snapshotTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(Fixture.Source + "\n\n", fixture.SourcePath))
        let snapshot = project.GetCompilationForSnapshot(fixture.SourcePath, snapshotTree)
        Assert.Equal("App", snapshot.AssemblyName)
        Assert.False(HasInternalAccessErrors(snapshot))
        // Roslyn-style factories on the compilation itself copy the name.
        let replaced = successor.WithReplacedSyntaxTree(successor.SyntaxTrees[0], snapshotTree)
        Assert.Equal("App", replaced.AssemblyName)
        Assert.False(HasInternalAccessErrors(replaced))
    }

    @Fact
    func RenamingTheProject_RebuildsWithTheNewName() {
        using let fixture = Fixture("App")
        let project = fixture.NewProject("Other")
        Assert.True(HasInternalAccessErrors(project.GetCompilation()))
        project.AssemblyName = "App"
        let renamed = project.GetCompilation()
        Assert.Equal("App", renamed.AssemblyName)
        Assert.False(HasInternalAccessErrors(renamed))
        project.AssemblyName = "Other"
        let back = project.GetCompilation()
        Assert.Equal("Other", back.AssemblyName)
        Assert.True(HasInternalAccessErrors(back))
    }

    private func HasInternalAccessErrors(compilation Compilation) bool {
        return compilation.BoundProgram.Diagnostics.Any((d Diagnostic) -> d.IsError)
    }

    private class Fixture : IDisposable {
        shared {
            internal const Source string = `package Consumer
import Lib
func Use() int32 {
    return Hidden.Value()
}`
        }

        init(friend string) {
            Directory = Path.Combine(
                System.IO.Directory.GetCurrentDirectory(),
                "adr0212-s6b-" + Guid.NewGuid().ToString("N")
            )
            System.IO.Directory.CreateDirectory(Directory)
            SourcePath = Path.Combine(Directory, "Use.gs")
            LibraryPath = Path.Combine(Directory, "Lib.dll")
            let csharp = "[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(\"" +
                friend.Replace("\"", "\\\"") +
                "\")]\nnamespace Lib { internal static class Hidden { internal static int Value() => 1; } }"
            let compilation = CSharpCompilation.Create(
                "Lib",
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(csharp)},
                []Microsoft.CodeAnalysis.PortableExecutableReference{Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(LibraryPath)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        prop Directory string {
            get;
        }
        prop SourcePath string {
            get;
        }
        prop LibraryPath string {
            get;
        }

        func NewProject(assemblyName string?) ProjectState {
            let project = ProjectState(Path.Combine(Directory, "App.gsproj"))
            project.AssemblyName = assemblyName
            project.References = []string{typeof(object).Assembly.Location, LibraryPath}
            project.UpdateFile(SourcePath, Fixture.Source)
            return project
        }

        func Dispose() {
            try {
                System.IO.Directory.Delete(Directory, recursive: true)
            } catch (IOException) {
            }
        }
    }
}
