// <copyright file="Issue3414DelegateArgumentInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue3414DelegateArgumentInferenceTests
{
    private const string CoreSource = """
        namespace CoreModel;

        public sealed class Diagnostic
        {
            public Diagnostic(bool isError)
            {
                IsError = isError;
            }

            public bool IsError { get; }
        }
        """;

    private const string ReplSource = """
        using System;
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
        }
        """;

    private const string ScopeIsolationSource = """
        using System;
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
        }
        """;

    private const string CellSource = """
        using System.Collections.Immutable;
        using CoreModel;

        namespace ReplModel;

        public sealed class Cell
        {
            public Cell(ImmutableArray<Diagnostic> diagnostics)
            {
                Diagnostics = diagnostics;
            }

            public ImmutableArray<Diagnostic> Diagnostics { get; }
        }
        """;

    private const string ProtocolSource = """
        namespace GSharp.LanguageServer.Protocol;

        public sealed class Diagnostic
        {
        }
        """;

    [Fact]
    public void DirectLambdaAndMethodGroupArguments_PreserveExactDelegateTypes()
    {
        string[] translated = Translate(
            ("Diagnostic.cs", CoreSource),
            ("Cell.cs", CellSource),
            ("Protocol.cs", ProtocolSource),
            ("Program.cs", ReplSource));
        string consumer = translated.Single(source => source.Contains("class Program", StringComparison.Ordinal));

        Assert.Contains(
            "SelectMany(func (c Cell) IEnumerable[CoreModel.Diagnostic]",
            consumer,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "SelectMany((c Cell) -> c.Diagnostics)",
            consumer,
            StringComparison.Ordinal);
        Assert.Contains("Count(", consumer, StringComparison.Ordinal);
        Assert.Contains("DiagnosticsOf", consumer, StringComparison.Ordinal);
        Assert.Contains("IsError", consumer, StringComparison.Ordinal);
        Assert.Contains(
            "ApplyDescription(cell, func (value Cell) object",
            consumer,
            StringComparison.Ordinal);
        Assert.Contains("return Program.Describe(value)", consumer, StringComparison.Ordinal);
        Assert.Contains(
            "Rebuilder(func (value Cell) object",
            consumer,
            StringComparison.Ordinal);
        Assert.Contains("return Cell(value.Diagnostics)", consumer, StringComparison.Ordinal);
        Assert.Contains(
            "ApplyDescription(cell, func (value Cell) object",
            consumer,
            StringComparison.Ordinal);
        Assert.Contains("return value.Diagnostics.Length", consumer, StringComparison.Ordinal);
        Assert.Contains("return value.GetType().Name", consumer, StringComparison.Ordinal);
        Assert.Contains("ApplyVisit(cell, (value Cell) -> {", consumer, StringComparison.Ordinal);
        Assert.DoesNotContain("ApplyVisit(cell, func", consumer, StringComparison.Ordinal);
        Assert.Contains("d CoreModel.Diagnostic", consumer, StringComparison.Ordinal);
        Assert.All(
            translated,
            source =>
            {
                RoundTripResult roundTrip = GSharpRoundTrip.Validate(source);
                Assert.True(
                    roundTrip.Success,
                    string.Join(Environment.NewLine, roundTrip.Errors));
            });
    }

    [Fact]
    public void BlockLambdaReturnScan_ExcludesNestedLambdasAndLocalFunctions()
    {
        string[] translated = Translate(
            ("Diagnostic.cs", CoreSource),
            ("Cell.cs", CellSource),
            ("ScopeIsolation.cs", ScopeIsolationSource));
        string consumer = translated.Single(source =>
            source.Contains("class ScopeIsolation", StringComparison.Ordinal));

        Assert.Contains("ApplyText(cell, (value Cell) -> {", consumer, StringComparison.Ordinal);
        Assert.DoesNotContain("ApplyText(cell, func", consumer, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReplShape_TranslatesCompilesVerifiesAndRuns()
    {
        string compiler = FindCompiler();
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        Assert.NotNull(compiler);
        Assert.NotNull(repoRoot);
        Assert.NotNull(GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, "Release"));
        Assert.True(IlVerifyToolAvailable(), "dotnet-ilverify must be available.");

        string sourceRoot = NewDirectory("scratch-projects");
        Fixture fixture = WriteFixture(sourceRoot);
        RunDotnetBuild(fixture.ReplProject);

        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
                Config = "Release",
            },
            new IMigrationStage[]
            {
                new TranslateStage(),
                new CompileStage(),
                new IlVerifyStage(),
                new TestParityStage(),
            });

        RunResult result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Issue3414.Core", fixture.CoreProject, TargetKind.Library),
            new CorpusApp(
                "test/Issue3414.Repl",
                fixture.ReplProject,
                TargetKind.Exe,
                stdoutGolden: fixture.StdoutGolden),
        });
        AppResult appResult = Assert.Single(
            result.Apps,
            app => app.AppId == "test/Issue3414.Repl");
        string appDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(appResult.AppId));
        string translated = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("SelectMany(", translated, StringComparison.Ordinal);
        Assert.Contains("Count(", translated, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());
        Assert.All(
            result.Apps,
            app => Assert.True(
                app.Succeeded,
                app.AppId + ": "
                    + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));
    }

    private static string[] Translate(params (string Path, string Source)[] sources)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        return project.Documents.Select(document =>
            {
                var context = new TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath);
                CompilationUnit translated =
                    new CSharpToGSharpTranslator().TranslateDocument(document, context);
                Assert.DoesNotContain(
                    context.Diagnostics,
                    diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
                return GSharpPrinter.Print(translated);
            }).ToArray();
    }

    private static Fixture WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string coreDirectory = Path.Combine(sourceRoot, "CoreModel");
        Directory.CreateDirectory(coreDirectory);
        string coreProject = Path.Combine(coreDirectory, "CoreModel.csproj");
        File.WriteAllText(coreProject, ProjectFile());
        File.WriteAllText(Path.Combine(coreDirectory, "Diagnostic.cs"), CoreSource);

        string replDirectory = Path.Combine(sourceRoot, "Repl");
        Directory.CreateDirectory(replDirectory);
        string replProject = Path.Combine(replDirectory, "Repl.csproj");
        File.WriteAllText(
            replProject,
            ProjectFile("../CoreModel/CoreModel.csproj", outputType: "Exe"));
        File.WriteAllText(Path.Combine(replDirectory, "Cell.cs"), CellSource);
        File.WriteAllText(Path.Combine(replDirectory, "Protocol.cs"), ProtocolSource);
        File.WriteAllText(Path.Combine(replDirectory, "Program.cs"), ReplSource);

        string stdoutGolden = Path.Combine(sourceRoot, "baseline.stdout.golden");
        File.WriteAllText(stdoutGolden, "2\n2\nCell\n2\nCell\n2\nCell\n");
        return new Fixture(coreProject, replProject, stdoutGolden);
    }

    private static string ProjectFile(string projectReference = null, string outputType = null)
    {
        string output = outputType is null ? string.Empty : $"<OutputType>{outputType}</OutputType>";
        string reference = projectReference is null
            ? string.Empty
            : $"""
                <ItemGroup>
                  <ProjectReference Include="{projectReference}" />
                </ItemGroup>
              """;
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                {output}
              </PropertyGroup>
              {reference}
            </Project>
            """;
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("build");
        startInfo.ArgumentList.Add(projectPath);
        startInfo.ArgumentList.Add("--nologo");
        startInfo.ArgumentList.Add("--verbosity:quiet");

        using Process process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, "Fixture build failed:\n" + stdout + stderr);
    }

    private static bool IlVerifyToolAvailable()
    {
        try
        {
            return !IlVerifyRunner.IsEnabled || new IlVerifyRunner().EnsureToolAvailable();
        }
        catch
        {
            return false;
        }
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue3414",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private sealed record Fixture(
        string CoreProject,
        string ReplProject,
        string StdoutGolden);
}
