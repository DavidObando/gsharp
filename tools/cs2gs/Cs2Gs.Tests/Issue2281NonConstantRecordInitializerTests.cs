// <copyright file="Issue2281NonConstantRecordInitializerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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

/// <summary>
/// Regression tests for issue #2281: a C# property-bodied record whose
/// auto-property initializer is NOT a compile-time constant (a static
/// property/method call, <c>new Foo()</c>, etc.) was previously lifted to a
/// G# primary-constructor parameter DEFAULT (issue #2228's lift), which is
/// invalid — G# optional-parameter defaults must be compile-time constants
/// (GS0265) — and cascaded into GS0144/GS0161 at every construction and
/// <c>with</c> call site. The fix distinguishes the initializer shape via the
/// Roslyn semantic model (<c>GetConstantValue</c>, not a syntactic guess):
/// a constant initializer stays a primary-constructor parameter default
/// (unchanged, issue #2228 behavior); a non-constant one is instead lifted to
/// a plain body <c>let</c> field carrying the initializer, which the data
/// class's always-emitted parameterless constructor runs on every
/// construction — mirroring the C# record's own per-instance initializer
/// semantics without requiring a compile-time constant anywhere.
/// </summary>
public class Issue2281NonConstantRecordInitializerTests
{
    [Fact]
    public void RecordWithNonConstantStaticPropertyInitializer_LiftsToBodyLetField_NotParameterDefault()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CliPaths
    {
        public static string DefaultDownloadDir => ""downloads"";
    }

    public sealed record OahuConfig
    {
        public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
        public int MaxParallelJobs { get; init; } = 1;
    }
}");

        Assert.Contains("data class OahuConfig(MaxParallelJobs int32 = 1)", printed);
        Assert.DoesNotContain("(DownloadDirectory string = CliPaths.DefaultDownloadDir", printed);
        Assert.Contains("public let DownloadDirectory string = CliPaths.DefaultDownloadDir", printed);
    }

    [Fact]
    public void RecordWithNonConstantMethodCallInitializer_LiftsToBodyLetField()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Widget
    {
        public int Value;
    }

    public sealed record Holder
    {
        public Widget Item { get; init; } = new Widget();
        public int Count { get; init; } = 1;
    }
}");

        Assert.Contains("data class Holder(Count int32 = 1)", printed);
        Assert.Contains("public let Item Widget = Widget()", printed);
    }

    [Fact]
    public void RecordWithOnlyNonConstantInitializers_TranslatesToDataClassWithEmptyPrimaryCtor()
    {
        // Every property has a non-constant initializer: the primary
        // constructor's positional parameter list ends up EMPTY, and every
        // property becomes a body 'let' field — still a valid 'data class'
        // (at least one field, via the body fields), never downgraded to a
        // plain class.
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CliPaths
    {
        public static string DefaultDownloadDir => ""downloads"";
    }

    public sealed record OahuConfig
    {
        public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
    }
}");

        Assert.Contains("data class OahuConfig()", printed);
        Assert.DoesNotContain("class OahuConfig {", printed);
        Assert.Contains("public let DownloadDirectory string = CliPaths.DefaultDownloadDir", printed);
    }

    [Fact]
    public void RecordWithConstantInitializer_StillUsesParameterDefault()
    {
        // Baseline/regression from issue #2228: a genuinely constant
        // initializer (a `const` field reference) is unaffected and keeps
        // the primary-constructor-parameter-default form.
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CliPaths
    {
        public const string DefaultDownloadDir = ""downloads"";
    }

    public sealed record OahuConfig
    {
        public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
    }
}");

        Assert.Contains("data class OahuConfig(DownloadDirectory string = CliPaths.DefaultDownloadDir)", printed);
        Assert.DoesNotContain("let DownloadDirectory", printed);
    }

    [Fact]
    public void PropertyBodiedRecords_KeepTheirSynthesizedParameterlessConstruction()
    {
        string printed = TranslateUnit(@"
namespace Oahu.Cli.App
{
    public sealed record LibraryFilter
    {
        public string? Search { get; init; }
        public string? Author { get; init; }
        public string? Series { get; init; }
        public bool AvailableOnly { get; init; } = true;
    }

    public sealed record OahuConfig
    {
        public int Sequence { get; init; } = Next();
        public int MaxParallelJobs { get; init; } = 1;
        public bool KeepEncryptedFiles { get; init; }

        private static int Next() => 42;
        public static OahuConfig Default => new();
    }

    public static class Uses
    {
        public static LibraryFilter Filter() => new();
    }
}");

        Assert.Contains(
            "data class LibraryFilter(Search string? = default(string?), Author string? = default(string?), Series string? = default(string?), AvailableOnly bool = true)",
            printed);
        Assert.Contains("MaxParallelJobs int32 = 1, KeepEncryptedFiles bool = default(bool)", printed);
        Assert.Contains("public let Sequence int32 =", printed);
        Assert.Contains("prop Default OahuConfig -> OahuConfig()", printed);
        Assert.Contains("func Filter() LibraryFilter -> LibraryFilter()", printed);
    }

    [Fact]
    public async Task OahuCliAppShapes_ParameterlessConstruction_CompilesAndPreservesRuntimeDefaults()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null ||
            repoRoot is null ||
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        string projectDirectory = Path.Combine(sourceRoot, "Oahu.Cli.App");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Oahu.Cli.App.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), """
            using System;
            using System.Collections.Generic;
            using System.Text.Json;

            namespace Oahu.Cli.App.Paths
            {
                public static class CliPaths
                {
                    private static int calls;
                    public static string DefaultDownloadDir => (++calls).ToString();
                }
            }

            namespace Oahu.Cli.App.Models
            {
                using Oahu.Cli.App.Paths;

                public enum DownloadQuality { Low, Medium, High }

                public sealed record OahuConfig
                {
                    public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
                    public DownloadQuality DefaultQuality { get; init; } = DownloadQuality.High;
                    public int MaxParallelJobs { get; init; } = 1;
                    public bool KeepEncryptedFiles { get; init; }
                    public bool MultiPartDownload { get; init; }
                    public bool ExportToAax { get; init; }
                    public string ExportDirectory { get; init; } = "";
                    public string? DefaultProfileAlias { get; init; }
                    public string? Theme { get; init; }
                    public bool AllowEncryptedFileCredentials { get; init; }
                    public Dictionary<string, JsonElement>? ExtraProperties { get; init; }
                    public static OahuConfig Default => new();
                }
            }

            namespace Oahu.Cli.App.Library
            {
                public sealed record LibraryFilter
                {
                    public string? Search { get; init; }
                    public string? Author { get; init; }
                    public string? Series { get; init; }
                    public bool AvailableOnly { get; init; } = true;
                }
            }

            namespace Oahu.Cli.App
            {
                using Oahu.Cli.App.Library;
                using Oahu.Cli.App.Models;

                public static class Program
                {
                    public static void Main()
                    {
                        OahuConfig first = new();
                        OahuConfig second = OahuConfig.Default;
                        LibraryFilter filter = new();

                        Console.WriteLine(first.DownloadDirectory);
                        Console.WriteLine(second.DownloadDirectory);
                        Console.WriteLine(first.DefaultQuality == DownloadQuality.High);
                        Console.WriteLine(first.MaxParallelJobs);
                        Console.WriteLine(first.KeepEncryptedFiles);
                        Console.WriteLine(first.ExtraProperties is null);
                        Console.WriteLine(filter.Search is null);
                        Console.WriteLine(filter.AvailableOnly);
                    }
                }
            }
            """);

        string stdoutGolden = Path.Combine(sourceRoot, "baseline.stdout.golden");
        File.WriteAllText(stdoutGolden, "1\n2\nTrue\n1\nFalse\nTrue\nTrue\nTrue\n");
        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "Oahu.Cli.App",
            projectPath,
            TargetKind.Exe,
            stdoutGolden: stdoutGolden);
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage(), new TestParityStage() });

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        Assert.True(
            appResult.Succeeded,
            "Exact Oahu.Cli.App record shapes should translate, compile, and preserve runtime defaults. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    // Note: a `data struct` (record struct) counterpart of the non-constant-
    // initializer scenario above is not independently testable — C# itself
    // (CS8983) rejects a struct with ANY auto-property/field initializer that
    // lacks an explicitly declared instance constructor, and
    // AnalyzeAutoPropertyLift only ever runs when there is no explicit
    // instance constructor. So a record struct can never reach this
    // translator path with a non-constant initializer in the first place —
    // the defensive `kind == TypeDeclarationKind.DataStruct` bail in
    // AnalyzeAutoPropertyLift exists purely as a "never guess" safety net
    // (ADR-0115) in case that C# restriction is ever relaxed.

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2281",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirectoryName, string dllName)
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
                    projectDirectoryName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
