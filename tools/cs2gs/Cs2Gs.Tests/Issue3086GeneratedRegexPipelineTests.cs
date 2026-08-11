// <copyright file="Issue3086GeneratedRegexPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #3086: GeneratedRegex partial declarations survive migration as equivalent cached regexes.</summary>
[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue3086GeneratedRegexPipelineTests
{
    [Fact]
    public async Task PartialRecord_GeneratedRegex_TranslatesCompilesVerifiesAndRuns()
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
        string projectDirectory = Path.Combine(sourceRoot, "Issue3086GeneratedRegex");
        CopyFixture(projectDirectory);

        string projectPath = Path.Combine(projectDirectory, "Issue3086GeneratedRegex.csproj");
        string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "test/Issue3086GeneratedRegex",
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
        string translated = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
        string defaultPatternField = translated.Split(Environment.NewLine).Single(
            line => line.Contains("__generatedRegex_DefaultPattern Regex =", StringComparison.Ordinal));
        string infinitePatternField = translated.Split(Environment.NewLine).Single(
            line => line.Contains("__generatedRegex_InfinitePattern Regex =", StringComparison.Ordinal));

        Assert.Contains("let __generatedRegex_Pattern Regex = Regex(", translated, StringComparison.Ordinal);
        Assert.Contains("RegexOptions.ExplicitCapture", translated, StringComparison.Ordinal);
        Assert.Contains("TimeSpan.FromMilliseconds(1000.0)", translated, StringComparison.Ordinal);
        Assert.Contains("func Pattern() Regex -> __generatedRegex_Pattern", translated, StringComparison.Ordinal);
        Assert.Contains("let __generatedRegex_DefaultPattern Regex = Regex(", translated, StringComparison.Ordinal);
        Assert.Contains("RegexOptions.None", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("Regex.InfiniteMatchTimeout", defaultPatternField, StringComparison.Ordinal);
        Assert.Contains(
            "func DefaultPattern() Regex -> __generatedRegex_DefaultPattern",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "let __generatedRegex_InfinitePattern Regex = Regex(",
            translated,
            StringComparison.Ordinal);
        Assert.Contains("Regex.InfiniteMatchTimeout", infinitePatternField, StringComparison.Ordinal);
        Assert.Contains(
            "func InfinitePattern() Regex -> __generatedRegex_InfinitePattern",
            translated,
            StringComparison.Ordinal);
        Assert.Contains("RegexOptions.CultureInvariant", translated, StringComparison.Ordinal);
        Assert.Contains(
            "let __generatedRegex_LowercaseWords Regex = Regex(",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "partial class InstanceRegexOwner {" + Environment.NewLine +
            "    func LowercaseWords() Regex -> __generatedRegex_LowercaseWords",
            translated,
            StringComparison.Ordinal);
        Assert.DoesNotContain("@GeneratedRegex", translated, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());
    }

    [Fact]
    public async Task InlineIgnoreCaseWithoutInvariant_ReportsUnsupported()
    {
        string sourceRoot = NewDirectory("scratch-projects");
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "Issue3086InlineIgnoreCase");
        CopyFixture(projectDirectory);
        File.WriteAllText(
            Path.Combine(projectDirectory, "Program.cs"),
            """
            using System.Text.RegularExpressions;

            public static partial class Patterns
            {
                [GeneratedRegex("(?i)abc")]
                private static partial Regex GlobalIgnoreCase();

                [GeneratedRegex("(?i:abc)")]
                private static partial Regex ScopedIgnoreCase();

                [GeneratedRegex("(?-i)(?m-i)(?im-s:abc)")]
                private static partial Regex ToggledIgnoreCase();

                [GeneratedRegex("(?-i:abc)")]
                private static partial Regex DisabledIgnoreCase();

                [GeneratedRegex(@"\(\?i\)")]
                private static partial Regex EscapedLiteral();

                [GeneratedRegex("[(?i)]")]
                private static partial Regex CharacterClassLiteral();

                [GeneratedRegex("(?i)abc", RegexOptions.CultureInvariant)]
                private static partial Regex InvariantIgnoreCase();
            }

            public static class Program
            {
                public static void Main()
                {
                }
            }
            """);

        string projectPath = Path.Combine(projectDirectory, "Issue3086GeneratedRegex.csproj");
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(
            candidate => Path.GetFileName(candidate.FilePath) == "Program.cs");
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string translated = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        TranslationDiagnostic[] diagnostics = context.Diagnostics
            .Where(diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported)
            .ToArray();

        Assert.Equal(3, diagnostics.Length);
        Assert.All(
            diagnostics,
            diagnostic => Assert.Contains(
                "including inline option groups",
                diagnostic.Message,
                StringComparison.Ordinal));
        Assert.Contains("func DisabledIgnoreCase()", translated, StringComparison.Ordinal);
        Assert.Contains("func EscapedLiteral()", translated, StringComparison.Ordinal);
        Assert.Contains("func CharacterClassLiteral()", translated, StringComparison.Ordinal);
        Assert.Contains("func InvariantIgnoreCase()", translated, StringComparison.Ordinal);
    }

    private static void CopyFixture(string destination)
    {
        string source = Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue3086GeneratedRegex");
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
        {
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        }
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
            "issue3086",
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
}
