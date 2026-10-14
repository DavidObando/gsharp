// <copyright file="Issue3085PrimitiveStaticReceiverTranslationTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

/// Issue #3085: predefined C# type receivers use the same canonical spelling
/// as G# type clauses.
open class Issue3085PrimitiveStaticReceiverTranslationTests {
    @Theory
    @InlineData("bool.TrueString", "bool.TrueString")
    @InlineData("byte.MaxValue", "uint8.MaxValue")
    @InlineData("sbyte.MinValue", "int8.MinValue")
    @InlineData("short.MinValue", "int16.MinValue")
    @InlineData("ushort.MaxValue", "uint16.MaxValue")
    @InlineData("int.MinValue", "int32.MinValue")
    @InlineData("uint.MaxValue", "uint32.MaxValue")
    @InlineData("long.MinValue", "int64.MinValue")
    @InlineData("ulong.MaxValue", "uint64.MaxValue")
    @InlineData("nint.MinValue", "nint.MinValue")
    @InlineData("nuint.MaxValue", "nuint.MaxValue")
    @InlineData("float.NaN", "float32.NaN")
    @InlineData("double.NaN", "float64.NaN")
    @InlineData("decimal.Zero", "decimal.Zero")
    @InlineData("char.MaxValue", "char.MaxValue")
    @InlineData("string.Empty", "string.Empty")
    @InlineData("object.ReferenceEquals(null, null)", "object.ReferenceEquals(nil, nil)")
    func PredefinedStaticReceiver_UsesCanonicalGSharpType(expression string, expected string) {
        let printed = Translate((`using System;

namespace Issue3085;

public static class Host
{
    public static void Run() => Console.WriteLine(` + "$expression" + `);
}`))
        Assert.Contains(expected, printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    @Fact
    async func PrimitiveStaticReceiverFixture_EmitsCanonicalReceiver_RoundTripsCompilesAndRuns() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3085")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue3085.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), IntParseSource)
        let stdoutGolden = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(stdoutGolden, `314159
10,20,30
`)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{Config: "Debug", GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync(
            []CorpusApp{CorpusApp("test/Issue3085", projectPath, TargetKind.Exe, stdoutGolden)}
        )
        let app = Assert.Single(result.Apps)
        let emitted = File.ReadAllText(
            Assert.Single(
                Directory.GetFiles(
                    Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId)),
                    "*.gs",
                    SearchOption.AllDirectories
                )
            )
        )
        Assert.Contains("int32.Parse(\"314159\")", emitted, StringComparison.Ordinal)
        Assert.Contains("string.Join(", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("Int32.Parse", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("String.Join", emitted, StringComparison.Ordinal)
        AssertRoundTrip(emitted)
        Assert.True(
            app.Succeeded,
            "Expected translated int.Parse fixture to compile and run. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    shared {
        private const IntParseSource string = `using System;

Console.WriteLine(int.Parse("314159"));
Console.WriteLine(string.Join(",", new[] { 10, 20, 30 }));`

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
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3085", Guid.NewGuid().ToString("N"))
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
    }
}
