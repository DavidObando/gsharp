// <copyright file="Issue3086GeneratedRegexPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
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

        Assert.Contains("let __generatedRegex_Pattern Regex = Regex(", translated, StringComparison.Ordinal);
        Assert.Contains("RegexOptions.ExplicitCapture", translated, StringComparison.Ordinal);
        Assert.Contains("TimeSpan.FromMilliseconds(1000.0)", translated, StringComparison.Ordinal);
        Assert.Contains("func Pattern() Regex -> __generatedRegex_Pattern", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("@GeneratedRegex", translated, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());
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
