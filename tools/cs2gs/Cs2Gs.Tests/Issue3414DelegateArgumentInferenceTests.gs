// <copyright file="Issue3414DelegateArgumentInferenceTests.cs" company="GSharp">
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
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

@Collection("IlVerifyPipeline")
class Issue3414DelegateArgumentInferenceTests {
    @Fact
    func DirectLambdaAndMethodGroupArguments_PreserveExactDelegateTypes() {
        let translated = Translate(
            ("Diagnostic.cs", CoreSource),
            ("Cell.cs", CellSource),
            ("Protocol.cs", ProtocolSource),
            ("Program.cs", ReplSource)
        )
        let consumer = translated.Single(
            (source string) -> source.Contains("class Program", StringComparison.Ordinal)
        )!!
        Assert.Contains(
            "SelectMany(func (c Cell) IEnumerable[CoreModel.Diagnostic]",
            consumer,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("SelectMany((c Cell) -> c.Diagnostics)", consumer, StringComparison.Ordinal)
        Assert.Contains("Count(", consumer, StringComparison.Ordinal)
        Assert.Contains("DiagnosticsOf", consumer, StringComparison.Ordinal)
        Assert.Contains("IsError", consumer, StringComparison.Ordinal)
        // Issue #3505 (fixed): a reference-variant method group against a
        // source-defined callee's native slot now emits the direct reference
        // — gsc binds it at the target type — instead of the wrapper lambda.
        Assert.Contains("ApplyDescription(cell, Describe)", consumer, StringComparison.Ordinal)
        Assert.DoesNotContain("return Program.Describe(value)", consumer, StringComparison.Ordinal)
        Assert.Contains("Rebuilder(func (value Cell) object", consumer, StringComparison.Ordinal)
        Assert.Contains("return Cell(value.Diagnostics)", consumer, StringComparison.Ordinal)
        Assert.Contains("ApplyDescription(cell, func (value Cell) object", consumer, StringComparison.Ordinal)
        Assert.Contains("return value.Diagnostics.Length", consumer, StringComparison.Ordinal)
        Assert.Contains("return value.GetType().Name", consumer, StringComparison.Ordinal)
        Assert.Contains("ApplyVisit(cell, (value Cell) -> {", consumer, StringComparison.Ordinal)
        Assert.DoesNotContain("ApplyVisit(cell, func", consumer, StringComparison.Ordinal)
        Assert.Contains("d CoreModel.Diagnostic", consumer, StringComparison.Ordinal)
        Assert.All(
            translated,
            (source string) -> {
                let roundTrip = GSharpRoundTrip.Validate(source)
                Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
            }
        )
    }

    @Fact
    func BlockLambdaReturnScan_ExcludesNestedLambdasAndLocalFunctions() {
        let translated = Translate(
            ("Diagnostic.cs", CoreSource),
            ("Cell.cs", CellSource),
            ("ScopeIsolation.cs", ScopeIsolationSource)
        )
        let consumer = translated.Single(
            (source string) -> source.Contains("class ScopeIsolation", StringComparison.Ordinal)
        )!!
        Assert.Contains("ApplyText(cell, (value Cell) -> {", consumer, StringComparison.Ordinal)
        Assert.DoesNotContain("ApplyText(cell, func", consumer, StringComparison.Ordinal)
    }

    @Fact
    async func ReplShape_TranslatesCompilesVerifiesAndRuns() {
        let compiler string? = FindCompiler()
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        Assert.NotNull(compiler)
        Assert.NotNull(repoRoot)
        Assert.NotNull(GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, "Release"))
        Assert.True(IlVerifyToolAvailable(), "dotnet-ilverify must be available.")
        let sourceRoot = NewDirectory("scratch-projects")
        let fixture = WriteFixture(sourceRoot)
        RunDotnetBuild(fixture.ReplProject)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot, Config: "Release"},
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp("test/Issue3414.Core", fixture.CoreProject, TargetKind.Library),
                CorpusApp(
                    "test/Issue3414.Repl",
                    fixture.ReplProject,
                    TargetKind.Exe,
                    stdoutGolden: fixture.StdoutGolden
                )
            }
        )
        let appResult = Assert.Single(result.Apps, (app AppResult) -> app.AppId == "test/Issue3414.Repl")
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appResult.AppId))
        let translated = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("SelectMany(", translated, StringComparison.Ordinal)
        Assert.Contains("Count(", translated, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
        Assert.All(
            result.Apps,
            (app AppResult) -> Assert.True(
                app.Succeeded,
                app.AppId + ": " + string.Join(
                    "; ",
                    app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
        )
    }

    private data class Fixture(CoreProject string, ReplProject string, StdoutGolden string) : IEquatable[
        Issue3414DelegateArgumentInferenceTests.Fixture
    ] { }

    shared {
        private const CoreSource string = `namespace CoreModel;

public sealed class Diagnostic
{
    public Diagnostic(bool isError)
    {
        IsError = isError;
    }

    public bool IsError { get; }
}`

        private const ReplSource string = `using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using CoreModel;
using GSharp.LanguageServer.Protocol;
using ReplModel;

public sealed class Rebuilder
{
    private readonly Func<Cell, object> rebuild;

    public Rebuilder(Func<Cell, object> rebuild)
    {
        this.rebuild = rebuild;
    }

    public object Run(Cell cell) => rebuild(cell);
}

public static class Program
{
    public static void Main()
    {
        IReadOnlyList<Cell> cells = new[]
        {
            new Cell(ImmutableArray.Create(
                new CoreModel.Diagnostic(true),
                new CoreModel.Diagnostic(false))),
            new Cell(ImmutableArray.Create(new CoreModel.Diagnostic(true))),
        };

        Console.WriteLine(CountLambdas(cells));
        Console.WriteLine(CountMethodGroups(cells));
        Console.WriteLine(DescribeCell(cells[0]));
        Console.WriteLine(DescribeCellBlock(cells[0], numeric: true));
        Console.WriteLine(DescribeCellBlock(cells[0], numeric: false));
        Console.WriteLine(VisitCell(cells[0]));
        Console.WriteLine(RebuildCell(cells[0]).GetType().Name);
    }

    public static int CountLambdas(IReadOnlyList<Cell> cells) =>
        cells.SelectMany(c => c.Diagnostics).Count(d => d.IsError);

    public static int CountMethodGroups(IReadOnlyList<Cell> cells) =>
        cells.SelectMany(DiagnosticsOf).Count(IsError);

    public static object DescribeCell(Cell cell) =>
        ApplyDescription(cell, Describe);

    public static object DescribeCellBlock(Cell cell, bool numeric) =>
        ApplyDescription(cell, value =>
        {
            if (numeric)
            {
                return value.Diagnostics.Length;
            }

            return value.GetType().Name;
        });

    public static int VisitCell(Cell cell)
    {
        int count = 0;
        ApplyVisit(cell, value =>
        {
            count = value.Diagnostics.Length;
            return;
        });
        return count;
    }

    public static object RebuildCell(Cell cell) =>
        new Rebuilder(value => new Cell(value.Diagnostics)).Run(cell);

    private static object ApplyDescription(
        Cell cell,
        Func<Cell, object> describe) =>
        describe(cell);

    private static void ApplyVisit(Cell cell, Action<Cell> visit) =>
        visit(cell);

    private static IEnumerable<CoreModel.Diagnostic> DiagnosticsOf(Cell cell) =>
        cell.Diagnostics;

    private static bool IsError(CoreModel.Diagnostic diagnostic) =>
        diagnostic.IsError;

    private static string Describe(object value) =>
        value.GetType().Name;
}`

        private const ScopeIsolationSource string = `using System;
using ReplModel;

public static class ScopeIsolation
{
    public static string Describe(Cell cell) =>
        ApplyText(cell, value =>
        {
            Func<Cell, int> nested = nestedValue =>
            {
                return nestedValue.Diagnostics.Length;
            };

            int Local(Cell localValue)
            {
                return localValue.Diagnostics.Length;
            }

            return value.GetType().Name + nested(value) + Local(value);
        });

    private static string ApplyText(Cell cell, Func<Cell, string> describe) =>
        describe(cell);
}`

        private const CellSource string = `using System.Collections.Immutable;
using CoreModel;

namespace ReplModel;

public sealed class Cell
{
    public Cell(ImmutableArray<Diagnostic> diagnostics)
    {
        Diagnostics = diagnostics;
    }

    public ImmutableArray<Diagnostic> Diagnostics { get; }
}`

        private const ProtocolSource string = `namespace GSharp.LanguageServer.Protocol;

public sealed class Diagnostic
{
}`

        private func Translate(sources ...(Path string, Source string))[]string? {
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            return project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
                    Assert.DoesNotContain(
                        context.Diagnostics,
                        (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                    )
                    return GSharpPrinter.Print(translated)
                }
            )
                .ToArray()
        }

        private func WriteFixture(sourceRoot string) Issue3414DelegateArgumentInferenceTests.Fixture {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let coreDirectory = Path.Combine(sourceRoot, "CoreModel")
            Directory.CreateDirectory(coreDirectory)
            let coreProject = Path.Combine(coreDirectory, "CoreModel.csproj")
            File.WriteAllText(coreProject, ProjectFile())
            File.WriteAllText(Path.Combine(coreDirectory, "Diagnostic.cs"), CoreSource)
            let replDirectory = Path.Combine(sourceRoot, "Repl")
            Directory.CreateDirectory(replDirectory)
            let replProject = Path.Combine(replDirectory, "Repl.csproj")
            File.WriteAllText(replProject, ProjectFile("../CoreModel/CoreModel.csproj", outputType: "Exe"))
            File.WriteAllText(Path.Combine(replDirectory, "Cell.cs"), CellSource)
            File.WriteAllText(Path.Combine(replDirectory, "Protocol.cs"), ProtocolSource)
            File.WriteAllText(Path.Combine(replDirectory, "Program.cs"), ReplSource)
            let stdoutGolden = Path.Combine(sourceRoot, "baseline.stdout.golden")
            File.WriteAllText(stdoutGolden, `2
2
Cell
2
Cell
2
Cell
`)
            return Issue3414DelegateArgumentInferenceTests.Fixture(coreProject, replProject, stdoutGolden)
        }

        private func ProjectFile(projectReference string? = nil, outputType string? = nil) string {
            let output = if outputType == nil {
                string.Empty
            } else {
                "<OutputType>$outputType</OutputType>"
            }
            let reference = if projectReference == nil {
                string.Empty
            } else {
                (`  <ItemGroup>
    <ProjectReference Include="` + "$projectReference" + `" />
  </ItemGroup>`)
            }
            return (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    ` + "$output" + `
  </PropertyGroup>
  ` + "$reference" + `
</Project>`)
        }

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add("build")
            startInfo.ArgumentList.Add(projectPath)
            startInfo.ArgumentList.Add("--nologo")
            startInfo.ArgumentList.Add("--verbosity:quiet")
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, "Fixture build failed:\n" + stdout + stderr)
        }

        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3414", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
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
