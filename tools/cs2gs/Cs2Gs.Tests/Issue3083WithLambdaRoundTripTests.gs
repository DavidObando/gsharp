// <copyright file="Issue3083WithLambdaRoundTripTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

class Issue3083WithLambdaRoundTripTests {
    @Fact
    func SelectWithExpressionFollowedByWhere_RoundTrips() {
        let printed = Translate(WithSource)
        Assert.Contains(".Select((s ArchScenario) -> (s with { Steps = ", printed, StringComparison.Ordinal)
        Assert.Contains(".Where((s ArchScenario) ->", printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    @Fact
    func TypedNullArrayCast_UsesDefaultAndRoundTrips() {
        let printed = Translate(TypedNullSource)
        Assert.Contains(
            "Split(default([]?char), StringSplitOptions.RemoveEmptyEntries)",
            printed,
            StringComparison.Ordinal
        )
        AssertRoundTrip(printed)
    }

    @Fact
    async func SelectWithExpressionFollowedByWhere_CompilesAndRuns() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3083")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue3083.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), WithSource)
        let stdoutGolden = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(stdoutGolden, "2\n")
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{Config: "Debug", GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync(
            []CorpusApp{CorpusApp("test/Issue3083", projectPath, TargetKind.Exe, stdoutGolden)}
        )
        let app = Assert.Single(result.Apps)
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId)),
                "*.gs",
                SearchOption.AllDirectories
            )
                .Select(File.ReadAllText)
        )
        // ADR-0179 phase 7b: the gsfmt post-pass wraps this call. The shape of
        // the emitted `with` expression is what issue #3083 is about, not its
        // layout, which the formatter now owns — so match the construct and let
        // the line breaks fall where they may. See ContainsIgnoringWrap.
        ContainsIgnoringWrap(".Select((s ArchScenario) -> (s with{ Steps = ", emitted)
        Assert.True(
            app.Succeeded,
            "Expected translated LINQ with-expression to compile and run. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    shared {
        private const WithSource string = `using System;
using System.Collections.Generic;
using System.Linq;

namespace Issue3083;

public sealed record ScenarioStep(string From, string To);

public sealed record ArchScenario(IReadOnlyList<ScenarioStep> Steps);

public sealed record ArchitectureDoc(IReadOnlyList<ArchScenario>? Scenarios);

public static class Program
{
    public static List<ArchScenario> Project(
        ArchitectureDoc doc,
        HashSet<string> ids)
    {
        var scenarios = (doc.Scenarios ?? [])
            .Select(s => s with
            {
                Steps = s.Steps
                    .Where(st => ids.Contains(st.From) && ids.Contains(st.To))
                    .ToList(),
            })
            .Where(s => s.Steps.Count >= 2)
            .ToList();
        return scenarios;
    }

    public static void Main()
    {
        var ids = new HashSet<string> { "a", "b", "c" };
        var doc = new ArchitectureDoc(
            new List<ArchScenario>
            {
                new ArchScenario(
                    new List<ScenarioStep>
                    {
                        new ScenarioStep("a", "b"),
                        new ScenarioStep("b", "c"),
                        new ScenarioStep("c", "x"),
                    }),
            });
        Console.WriteLine(Project(doc, ids).Single().Steps.Count);
    }
}`

        private const TypedNullSource string = `using System;

namespace Issue3083;

public static class Repro
{
    public static int WordCount(string text) =>
        text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
}`

        /// Collapses every run of whitespace to one space.
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }

        private func AssertRoundTrip(printed string) {
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                string.Join(Environment.NewLine, roundTrip!!.Errors) + Environment.NewLine + printed
            )
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3083", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirectoryName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Debug", "Release"} {
                    let candidate = Path.Combine(
                        directory.FullName,
                        "out",
                        "bin",
                        configuration,
                        projectDirectoryName,
                        dllName
                    )
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        /// ADR-0179 phase 7b: asserts that [`actual`](paramref) contains the
        /// construct [`expected`](paramref) describes, without pinning where
        /// the formatter chose to break lines.
        ///
        /// Write [`expected`](paramref) in its unwrapped form. Whitespace is
        /// tolerated wherever a line break can legally sit — beside a bracket or a
        /// comma — and REQUIRED where the expectation puts it between two ordinary
        /// tokens, because `item Item` and `itemItem` are different programs. A
        /// blunt strip-all-whitespace comparison would accept the second, trading
        /// this test's brittleness for a hole in what it discriminates; the whole
        /// point of these assertions is which arguments carry a `!!`.
        /// @param expected The construct, written unwrapped.
        /// @param actual The emitted G#, raw and unnormalised.
        private func ContainsIgnoringWrap(expected string, actual string) {
            let IsToken = func (c char) bool {
                return char.IsLetterOrDigit(c) || (c == '_' || c == '.' || c == '!' || c == '?')
            }
            let pattern = StringBuilder()
            for var i = 0; i < expected.Length; i++ {
                let c = expected[i]
                if char.IsWhiteSpace(c) {
                    let start = i
                    while i + 1 < expected.Length && char.IsWhiteSpace(expected[i + 1]) {
                        i++
                    }
                    let boundedByTokens = start > 0 &&
                        IsToken(expected[start - 1]) &&
                        i +
                        1 < expected.Length &&
                        IsToken(expected[i + 1])
                    pattern.Append(
                        if boundedByTokens {
                            "\\s+"
                        } else {
                            "\\s*"
                        }
                    )
                    continue
                }
                if c == ')' || c == ']' || c == '}' {
                    pattern.Append("\\s*")
                }
                pattern.Append(Regex.Escape(c.ToString()))
                if c == '(' || c == '[' || c == '{' || c == ',' {
                    pattern.Append("\\s*")
                }
            }
            Assert.True(Regex.IsMatch(actual, pattern.ToString()), "expected to find (ignoring line breaks): $expected")
        }
    }
}
