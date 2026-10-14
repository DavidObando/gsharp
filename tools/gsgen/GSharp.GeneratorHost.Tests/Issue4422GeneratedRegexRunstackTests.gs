// <copyright file="Issue4422GeneratedRegexRunstackTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GSharp.GeneratorHost
import GSharp.GeneratorHost.Tests.StubTestSupport
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit
import Xunit.Abstractions

/// Issue #4422: a regex that backtracks inside a loop makes the real Regex
/// generator emit `Utilities.StackPush(ref base.runstack!, …)`. cs2gs drops
/// the `!` (G# cannot spell it on a variable) and translates it to
/// `&base.runstack`. Bound against the reference pack, which annotates
/// `RegexRunner.runstack` as `int[]?`, that argument was GS0154;
/// it is now accepted with GS0612, and cs2gs carries the C# author's
/// suppression across as an ADR-0175 `@SuppressDiagnostic("GS0612")` scope,
/// so the runner builds with no GS0612 left to fail a warnings-as-errors build.
open class Issue4422GeneratedRegexRunstackTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func BacktrackingLoopRunner_BuildsAgainstTheReferencePack_WithNoGS0612() {
        let generated = this.Generate()
        let helpers = string.Concat(generated.Select((file(HintName string, Source string)) -> file.Source))
        Assert.Contains("StackPush(&base.runstack", helpers, StringComparison.Ordinal)
        Assert.Contains("@SuppressDiagnostic(\"GS0612\")", helpers, StringComparison.Ordinal)
        // Nothing is left for a warnings-as-errors build to promote.
        let diagnostics = CompileAgainstReferencePack(generated)
        Assert.Empty(diagnostics)
    }

    @Fact
    func WithoutTheTranslatedSuppression_TheReferencePackReportsGS0612() {
        // Anti-vacuity: the reference pack really does annotate runstack, so
        // the suppression above is what removes the warning.
        let generated List[(HintName string, Source string)] = this
            .Generate()
            .Select(
            (file(HintName string, Source string)) -> (
                file.HintName,
                file.Source.Replace("@SuppressDiagnostic(\"GS0612\") ", string.Empty, StringComparison.Ordinal)
            )
        )
            .ToList()
        Assert.DoesNotContain(
            generated,
            (file(HintName string, Source string)) -> file.Source.Contains(
                "@SuppressDiagnostic(\"GS0612\")",
                StringComparison.Ordinal
            )
        )
        let diagnostics = CompileAgainstReferencePack(generated)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0612")
    }

    private func Generate() List[(HintName string, Source string)] {
        let user = Compilation(GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs")))
        let result = GeneratorHostRunner.RunFromAnalyzerPaths(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            []string{RegexGeneratorPath()!!}
        )
        Assert.Empty(result.Failures)
        Assert.Empty(result.GeneratorDiagnostics)
        Assert.NotEmpty(result.GeneratedGsFiles)
        let files = List[(HintName string, Source string)]()
        for (hintName, source) in result.GeneratedGsFiles {
            this.output.WriteLine("// " + hintName)
            this.output.WriteLine(source)
            files.Add((hintName, source))
        }
        return files
    }

    shared {
        private const UserSource string = `package App

import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("(foo|ba+r)+\\w*?baz", RegexOptions.IgnoreCase)
        private partial func Loop() Regex;

        public func Test(s string) bool {
            return Loop().IsMatch(s)
        }
    }
}
`

        private func CompileAgainstReferencePack(generated List[(HintName string, Source string)]) IReadOnlyList[
            Diagnostic
        ] {
            let trees = List[GsSyntaxTree]{GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs"))}
            trees.AddRange(
                generated.Select(
                    (file(HintName string, Source string)) -> GsSyntaxTree.Parse(
                        SourceText.From(file.Source, file.HintName + ".gs")
                    )
                )
            )
            let combined = Compilation(ReferenceResolver.WithReferences(RefPackAssemblies()), trees.ToArray()){
                IsLibrary = true
            }
            using let peStream = MemoryStream()
            let emit = combined.Emit(peStream)
            Assert.True(
                emit.Success,
                string.Join(
                    Environment.NewLine,
                    emit.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id + " " + diagnostic.Message)
                )
            )
            return emit.Diagnostics
        }

        private func RefPackAssemblies() IEnumerable[string] {
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            let dotnetRoot string? = Directory.GetParent(runtimeDir!!)?.Parent?.Parent?.FullName
            let tfm = "net${Environment.Version.Major}.0"
            let packsRoot = Path.Combine(dotnetRoot ?? string.Empty, "packs", "Microsoft.NETCore.App.Ref")
            let refDir string? = if Directory.Exists(packsRoot) {
                Directory
                    .EnumerateDirectories(packsRoot, Environment.Version.Major.ToString() + ".*")
                    .OrderByDescending((directory string) -> directory, StringComparer.Ordinal)
                    .Select((directory string) -> Path.Combine(directory, "ref", tfm))
                    .FirstOrDefault(Directory.Exists)
            } else {
                default(string?)
            }
            Assert.True(
                refDir != nil,
                "prerequisite missing: a Microsoft.NETCore.App.Ref pack for $tfm under '$packsRoot'"
            )
            return Directory.EnumerateFiles(refDir!!, "*.dll")
        }
    }
}
