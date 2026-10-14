// <copyright file="StubTestSupport.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Text
import GSharp.GeneratorHost
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

/// Shared helpers for tests that inspect the ADR-0145 §B C# stub: project G#
/// source to the stub, bind the stub the way a generator sees it, and locate the
/// real targeting-pack Regex generator.
internal shared class StubTestSupport {
    /// Projects [`gsSource`](paramref) to the declaration-only C# stub.
    /// @param gsSource The G# source.
    /// @returns The rendered stub.
    func Project(gsSource string) string {
        let compilation = Compilation(GsSyntaxTree.Parse(SourceText.From(gsSource, "User.gs")))
        return GsToCSharpProjection.ProjectToCSharp(compilation)
    }

    /// Binds [`stub`](paramref) against the runtime references, the same
    /// shape (cref:GeneratorRunner) hands a generator.
    /// @param stub The stub C#.
    /// @returns The C# compilation.
    func BindStub(stub string) CSharpCompilation {
        let tree = CSharpSyntaxTree.ParseText(stub, CSharpParseOptions(LanguageVersion.Latest), path: "GsgenStubs.cs")
        return CSharpCompilation.Create(
            "StubUnderTest",
            []Microsoft.CodeAnalysis.SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
    }

    /// Asserts that [`stub`](paramref) parses as C# with no syntax errors.
    /// @param stub The stub C#.
    func AssertParses(stub string) {
        let errors = CSharpSyntaxTree
            .ParseText(stub, CSharpParseOptions(LanguageVersion.Latest))
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToList()
        Assert.True(errors.Count == 0, "Stub did not parse as valid C#:\n" + stub + `

` + string.Join("\n", errors))
    }

    /// Returns the path of the `System.Text.RegularExpressions.Generator`
    /// that ships in the running SDK's `Microsoft.NETCore.App.Ref`
    /// targeting pack — the same asset the Gsharp.NET.Sdk hands gsgen for a
    /// project that references no package (see e2etests/gsgen-e2e.sh).
    /// @returns The generator assembly path.
    func RegexGeneratorPath() string? {
        // The shared framework lives at {dotnet_root}/shared/Microsoft.NETCore.App/{version}/.
        let runtimeDir = DirectoryInfo(Path.GetDirectoryName(typeof(object).Assembly.Location)!!)
        let dotnetRoot string? = runtimeDir.Parent?.Parent?.Parent?.FullName
        let packs string? = if dotnetRoot == nil {
            default(string?)
        } else {
            Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
        }
        // Prefer the ref pack matching the running runtime: a newer (e.g.
        // preview) pack's generator may need a newer Roslyn than the tests load.
        let path string? = if packs != nil && Directory.Exists(packs) {
            Directory
                .GetDirectories(packs)
                .Select(
                (dir string) -> Path.Combine(
                    dir,
                    "analyzers",
                    "dotnet",
                    "cs",
                    "System.Text.RegularExpressions.Generator.dll"
                )
            )
                .Where(File.Exists)
                .OrderByDescending((candidate string) -> PackVersionName(candidate) == runtimeDir.Name)
                .ThenByDescending(
                (candidate string) -> if Version.TryParse(PackVersionName(candidate).Split('-')[0], out var v) {
                    v
                } else {
                    Version(0, 0)
                }
            )
                .FirstOrDefault()
        } else {
            default(string?)
        }
        Assert.True(path != nil, "no System.Text.RegularExpressions.Generator.dll under '$packs'")
        return path
    }

    // {packs}/{version}/analyzers/dotnet/cs/{generator}.dll → {version}.
    private func PackVersionName(generatorPath string) string -> Directory.GetParent(
        generatorPath
    )!!.Parent!!.Parent!!.Parent!!.Name
}
