// <copyright file="Issue3092NullConditionalRangeSliceTests.cs" company="GSharp">
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
/// Issue #3092: a range nested under conditional element access keeps G#'s
/// native <c>value?[start..end]</c> form.
/// </summary>
[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue3092NullConditionalRangeSliceTests
{
    private const string Source = """
        #nullable enable
        using System;

        public static class Program
        {
            private static string Format(string? hash) =>
                $"prefix {hash?[..12]} suffix";

            private static string? Receiver(string? value)
            {
                Console.Write("R");
                return value;
            }

            private static int Start()
            {
                Console.Write("S");
                return 1;
            }

            private static int End()
            {
                Console.Write("E");
                return 4;
            }

            public static void Main()
            {
                Console.WriteLine(Format(null));
                Console.WriteLine(Format("0123456789abcdef"));
                Console.WriteLine(Format("0123456789ab"));

                try
                {
                    Console.WriteLine(Format("short"));
                }
                catch (ArgumentOutOfRangeException)
                {
                    Console.WriteLine("bounds");
                }

                Console.WriteLine(Receiver(null)?[Start()..End()] ?? "<nil>");
                Console.WriteLine(Receiver("abcdef")?[Start()..End()]);

                int[]? numbers = new[] { 10, 20, 30, 40 };
                int[]? middle = numbers?[1..3];
                Console.WriteLine(string.Join(",", middle!));

                ArraySegment<int>? segment =
                    new ArraySegment<int>(new[] { 1, 2, 3, 4 });
                ArraySegment<int>? segmentSlice = segment?[1..3];
                Console.WriteLine(segmentSlice?.Count);

                Memory<int>? memory = new Memory<int>(new[] { 5, 6, 7, 8 });
                Memory<int>? memorySlice = memory?[1..3];
                Console.WriteLine(memorySlice?.Length);
            }
        }
        """;

    private const string ExpectedOutput = """
        prefix  suffix
        prefix 0123456789ab suffix
        prefix 0123456789ab suffix
        bounds
        R<nil>
        RSEbcd
        20,30
        2
        2
        """;

    [Fact]
    public void ConditionalRange_UsesCanonicalNativeSyntaxWithoutSpills()
    {
        string printed = Translate(Source);

        Assert.Contains("hash?[..12]", printed, StringComparison.Ordinal);
        Assert.Contains(
            "Receiver(\"abcdef\")?[Start()..End()]",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("numbers?[1..3]", printed, StringComparison.Ordinal);
        Assert.Contains("segment?[1..3]", printed, StringComparison.Ordinal);
        Assert.Contains("memory?[1..3]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public async Task ConditionalRange_RoundTripsCompilesVerifiesAndRuns()
    {
        string compiler = FindCompiler();
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null ||
            repoRoot is null ||
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null ||
            !IlVerifyToolAvailable())
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "Issue3092");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Issue3092.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), Source);
        string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(goldenPath, ExpectedOutput.Replace("\r\n", "\n"));

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "test/Issue3092",
            projectPath,
            TargetKind.Exe,
            stdoutGolden: goldenPath);
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[]
            {
                new TranslateStage(),
                new CompileStage(),
                new IlVerifyStage(),
                new TestParityStage(),
            });

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        string appDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.Id));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("hash?[..12]", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", emitted, StringComparison.Ordinal);
        AssertRoundTrip(emitted);
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit =
            new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }

    private static void AssertRoundTrip(string printed)
    {
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            string.Join(Environment.NewLine, roundTrip.Errors) +
                Environment.NewLine +
                printed);
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
            "issue3092",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Debug", "Release" })
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
}
