// <copyright file="Issue2661ExpressionTreeNullablePipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2661ExpressionTreeNullablePipelineTests {
    @Fact
    async func Pipeline_OahuBookLibraryShape_CompilesAndPreservesDelegateRuntimeSafety() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let (apiProject, projectPath) = WriteFixture(sourceRoot)
        RunDotnetBuild(apiProject)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2661", projectPath, TargetKind.Exe)})
        let app = Assert.Single(result.Apps)
        let runDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        // Issue #4356: the reference receiver takes `!!` inside the tree too —
        // gsc elides a receiver check over a platform operand there and erases
        // a reference-type assertion (#3349) — while the nullable VALUE-type
        // reads keep their tree-safe spellings.
        Assert.Contains("b.Conversion!!.AccountId", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("b.PurchaseDate!!", emitted, StringComparison.Ordinal)
        Assert.Contains(".Select((b Book) -> b.PurchaseDate.Value)", emitted, StringComparison.Ordinal)
        Assert.Contains("book.Conversion!!.AccountId", emitted, StringComparison.Ordinal)
        Assert.Contains("book.PurchaseDate!!", emitted, StringComparison.Ordinal)
        Assert.True(
            app.Succeeded,
            "Expected expression-tree translation to compile without GS0473. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
        let assembly = Directory.GetFiles(
            Path.Combine(runDirectory, "bin"),
            "Issue2661.dll",
            SearchOption.AllDirectories
        )
            .Single(
            (path string) -> !path.Contains(
                Path.DirectorySeparatorChar + "ref" + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            )
        )
        let startInfo = ProcessStartInfo("dotnet", "\"" + assembly + "\""){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        using let process = Process.Start(startInfo)!!
        let output = process.StandardOutput.ReadToEnd()
        let error = process.StandardError.ReadToEnd()
        process.WaitForExit()
        Assert.True(process.ExitCode == 0, error)
        Assert.Equal(
            "2026${Environment.NewLine}account${Environment.NewLine}2026${Environment.NewLine}2026${Environment.NewLine}nullable${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    shared {
        private func WriteFixture(sourceRoot string)(ApiProject string, AppProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let apiDirectory = Path.Combine(sourceRoot, "Api")
            let projectDirectory = Path.Combine(sourceRoot, "Issue2661")
            Directory.CreateDirectory(apiDirectory)
            Directory.CreateDirectory(projectDirectory)
            let apiProject = Path.Combine(apiDirectory, "Api.csproj")
            File.WriteAllText(apiProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(apiDirectory, "Models.cs"), `using System;

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
}`)
            let projectPath = Path.Combine(projectDirectory, "Issue2661.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Api/Api.csproj" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(projectDirectory, "BookLibrary.cs"), `using System;
using System.Linq;
using System.Linq.Expressions;
using BookApi;

public static class BookLibrary
{
    public static DateTime SinceLatestPurchaseDate(
        IQueryable<Book> books,
        Conversion profileId)
    {
        var latest = books
            .Where(b => b.PurchaseDate.HasValue &&
                b.Conversion.AccountId == profileId.AccountId &&
                b.Conversion.Region == profileId.Region)
            .Select(b => b.PurchaseDate.Value)
            .OrderBy(b => b)
            .LastOrDefault();
        return latest + TimeSpan.FromMilliseconds(1);
    }

    public static void Main()
    {
        var book = new Book(
            new Conversion("account", "region"),
            new DateTime(2026, 7, 21));
        Console.WriteLine(
            SinceLatestPurchaseDate(
                new[] { book }.AsQueryable(),
                new Conversion("account", "region")).Year);
        Func<Book, string> account = book => book.Conversion.AccountId;
        Func<Book, DateTime> purchased = book => book.PurchaseDate.Value;
        Console.WriteLine(account(book));
        Console.WriteLine(purchased(book).Year);

        Expression<Func<Book, DateTime>> selected =
            value => value.PurchaseDate.Value;
        var compiled = selected.Compile();
        Console.WriteLine(compiled(book).Year);
        try
        {
            compiled(new Book(new Conversion("account", "region"), null));
        }
        catch (InvalidOperationException)
        {
            Console.WriteLine("nullable");
        }
    }
}`)
            return (apiProject, projectPath)
        }

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet", "build \"$projectPath\" --nologo --verbosity:quiet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1"
            using let process = Process.Start(startInfo)!!
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            process.WaitForExit()
            Assert.True(process.ExitCode == 0, "Failed to build API fixture:\n" + stdout + stderr)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2661", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirectoryName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
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
