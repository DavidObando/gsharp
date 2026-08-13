// <copyright file="Issue3085PrimitiveStaticReceiverTranslationTests.cs" company="GSharp">
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
/// Issue #3085: predefined C# type receivers use the same canonical spelling
/// as G# type clauses.
/// </summary>
public class Issue3085PrimitiveStaticReceiverTranslationTests
{
    private const string IntParseSource = """
        using System;

        Console.WriteLine(int.Parse("314159"));
        Console.WriteLine(string.Join(",", new[] { 10, 20, 30 }));
        """;

    [Theory]
    [InlineData("bool.TrueString", "bool.TrueString")]
    [InlineData("byte.MaxValue", "uint8.MaxValue")]
    [InlineData("sbyte.MinValue", "int8.MinValue")]
    [InlineData("short.MinValue", "int16.MinValue")]
    [InlineData("ushort.MaxValue", "uint16.MaxValue")]
    [InlineData("int.MinValue", "int32.MinValue")]
    [InlineData("uint.MaxValue", "uint32.MaxValue")]
    [InlineData("long.MinValue", "int64.MinValue")]
    [InlineData("ulong.MaxValue", "uint64.MaxValue")]
    [InlineData("nint.MinValue", "nint.MinValue")]
    [InlineData("nuint.MaxValue", "nuint.MaxValue")]
    [InlineData("float.NaN", "float32.NaN")]
    [InlineData("double.NaN", "float64.NaN")]
    [InlineData("decimal.Zero", "decimal.Zero")]
    [InlineData("char.MaxValue", "char.MaxValue")]
    [InlineData("string.Empty", "string.Empty")]
    [InlineData("object.ReferenceEquals(null, null)", "object.ReferenceEquals(nil, nil)")]
    public void PredefinedStaticReceiver_UsesCanonicalGSharpType(
        string expression,
        string expected)
    {
        string printed = Translate($$"""
            using System;

            namespace Issue3085;

            public static class Host
            {
                public static void Run() => Console.WriteLine({{expression}});
            }
            """);

        Assert.Contains(expected, printed, StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public async Task PrimitiveStaticReceiverFixture_EmitsCanonicalReceiver_RoundTripsCompilesAndRuns()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "Issue3085");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Issue3085.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), IntParseSource);
        string stdoutGolden = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(stdoutGolden, "314159\n10,20,30\n");

        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                Config = "Debug",
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage(), new TestParityStage() });
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue3085", projectPath, TargetKind.Exe, stdoutGolden) });
        AppResult app = Assert.Single(result.Apps);

        string emitted = File.ReadAllText(Assert.Single(Directory.GetFiles(
            Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId)),
            "*.gs",
            SearchOption.AllDirectories)));
        Assert.Contains("int32.Parse(\"314159\")", emitted, StringComparison.Ordinal);
        Assert.Contains("string.Join(", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("Int32.Parse", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("String.Join", emitted, StringComparison.Ordinal);
        AssertRoundTrip(emitted);
        Assert.True(
            app.Succeeded,
            "Expected translated int.Parse fixture to compile and run. Stages: "
                + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
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
            string.Join(Environment.NewLine, roundTrip.Errors) + Environment.NewLine + printed);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue3085",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirectoryName, string dllName)
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
