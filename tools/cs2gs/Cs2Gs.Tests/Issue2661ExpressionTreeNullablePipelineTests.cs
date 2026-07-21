// <copyright file="Issue2661ExpressionTreeNullablePipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2661ExpressionTreeNullablePipelineTests
{
    [Fact]
    public async Task Pipeline_OahuBookLibraryShape_CompilesAndPreservesDelegateRuntimeSafety()
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
        (string apiProject, string projectPath) = WriteFixture(sourceRoot);
        RunDotnetBuild(apiProject);
        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2661", projectPath, TargetKind.Exe) });
        AppResult app = Assert.Single(result.Apps);
        string runDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.DoesNotContain("b.Conversion!!", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("b.PurchaseDate!!", emitted, StringComparison.Ordinal);
        Assert.Contains("book.Conversion!!.AccountId", emitted, StringComparison.Ordinal);
        Assert.Contains("book.PurchaseDate!!", emitted, StringComparison.Ordinal);
        Assert.True(
            app.Succeeded,
            "Expected expression-tree translation to compile without GS0473. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));

        string assembly = Directory.GetFiles(
                Path.Combine(runDirectory, "bin"),
                "Issue2661.dll",
                SearchOption.AllDirectories)
            .Single(path => !path.Contains(
                Path.DirectorySeparatorChar + "ref" + Path.DirectorySeparatorChar,
                StringComparison.Ordinal));
        var startInfo = new ProcessStartInfo("dotnet", "\"" + assembly + "\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var process = Process.Start(startInfo)!;
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, error);
        Assert.Equal("account\n2026\n", output.Replace("\r\n", "\n"));
    }

    private static (string ApiProject, string AppProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string apiDirectory = Path.Combine(sourceRoot, "Api");
        string projectDirectory = Path.Combine(sourceRoot, "Issue2661");
        Directory.CreateDirectory(apiDirectory);
        Directory.CreateDirectory(projectDirectory);
        string apiProject = Path.Combine(apiDirectory, "Api.csproj");
        File.WriteAllText(apiProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(apiDirectory, "Models.cs"), """
            using System;

            namespace BookApi;

            public sealed class Conversion
            {
                public Conversion(string accountId, string region)
                {
                    AccountId = accountId;
                    Region = region;
                }

                public string AccountId { get; }
                public string Region { get; }
            }

            public sealed class Book
            {
                public Book(Conversion conversion, DateTime? purchaseDate)
                {
                    Conversion = conversion;
                    PurchaseDate = purchaseDate;
                }

                public DateTime? PurchaseDate { get; }
                public Conversion Conversion { get; }
            }
            """);
        string projectPath = Path.Combine(projectDirectory, "Issue2661.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="../Api/Api.csproj" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "BookLibrary.cs"), """
            using System;
            using System.Linq;
            using BookApi;

            public static class BookLibrary
            {
                public static void SinceLatestPurchaseDate(
                    IQueryable<Book> books,
                    Conversion profileId)
                {
                    var query = books
                        .Where(b => b.PurchaseDate.HasValue &&
                            b.Conversion.AccountId == profileId.AccountId &&
                            b.Conversion.Region == profileId.Region)
                        .Select(b => b.PurchaseDate.Value);
                }

                public static void Main()
                {
                    var book = new Book(
                        new Conversion("account", "region"),
                        new DateTime(2026, 7, 21));
                    Func<Book, string> account = book => book.Conversion.AccountId;
                    Func<Book, DateTime> purchased = book => book.PurchaseDate.Value;
                    Console.WriteLine(account(book));
                    Console.WriteLine(purchased(book).Year);
                }
            }
            """);
        return (apiProject, projectPath);
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo(
            "dotnet",
            $"build \"{projectPath}\" --nologo --verbosity:quiet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";

        using var process = Process.Start(startInfo)!;
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, "Failed to build API fixture:\n" + stdout + stderr);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2661",
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
