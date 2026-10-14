// <copyright file="Issue3096CollectionSpreadPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Translator-to-runtime parity and ILVerify coverage for issue #3096.
@Collection("IlVerifyPipeline")
class Issue3096CollectionSpreadPipelineTests {
    @Fact
    async func InitializerSpreads_TranslateCompileVerifyAndPreserveRuntimeOrder() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(
            repoRoot,
            "Debug"
        ) == nil ||
            !IlVerifyToolAvailable() {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3096")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue3096.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System;
using System.Collections.Generic;
using System.Linq;

public sealed class Celsius
{
    public Celsius(double degrees)
    {
        Degrees = degrees;
    }

    public double Degrees { get; }

    public static implicit operator double(Celsius value) => value.Degrees;
}

public sealed class Holder
{
    public static int Calls;
    public static string Trace = "";
    private static readonly string[] All = ["a", "b", "skip"];

    public static readonly string[] Filtered = [.. All.Where(x => x != "skip")];
    public static readonly string[] Ordered =
        [Mark("head", "A"), .. Source(), .. Array.Empty<string>(), Mark("tail", "C")];
    public static readonly string[] Empty = [.. Array.Empty<string>()];
    public static readonly string[] Mixed = ["before", .. Filtered, .. Empty, "after"];
    public static readonly List<string> ListTarget = ["list-head", .. Filtered, "list-tail"];
    private static readonly Celsius[] Temperatures =
        [new Celsius(2.5), new Celsius(3.5)];
    public static readonly double[] Converted =
        [1.0, .. Temperatures, 9.0];
    public static readonly List<double> ConvertedList =
        [.. Temperatures];

    public string[] Property { get; } =
        ["property-head", .. All.Where(x => x != "skip"), "property-tail"];

    public Holder()
    {
    }

    private static string Mark(string value, string marker)
    {
        Trace += marker;
        return value;
    }

    private static string[] Source()
    {
        Calls++;
        Trace += "B";
        return ["middle-1", "middle-2"];
    }

}

public static class Program
{
    public static void Main()
    {
        var holder = new Holder();
        Console.WriteLine(Holder.Filtered.Length);
        Console.WriteLine(Holder.Filtered[0]);
        Console.WriteLine(Holder.Filtered[1]);
        Console.WriteLine(Holder.Ordered.Length);
        Console.WriteLine(Holder.Ordered[0]);
        Console.WriteLine(Holder.Ordered[1]);
        Console.WriteLine(Holder.Ordered[2]);
        Console.WriteLine(Holder.Ordered[3]);
        Console.WriteLine(Holder.Trace);
        Console.WriteLine(Holder.Calls);
        Console.WriteLine(Holder.Empty.Length);
        Console.WriteLine(Holder.Mixed.Length);
        Console.WriteLine(Holder.ListTarget.Count);
        Console.WriteLine(Holder.ListTarget[2]);
        Console.WriteLine(holder.Property.Length);
        Console.WriteLine(holder.Property[0]);
        Console.WriteLine(holder.Property[3]);
        Console.WriteLine(Holder.Converted.Length);
        Console.WriteLine(Holder.Converted[1]);
        Console.WriteLine(Holder.Converted[2]);
        Console.WriteLine(Holder.ConvertedList.Count);
        Console.WriteLine(Holder.ConvertedList[0]);
        Console.WriteLine(Holder.ConvertedList[1]);
    }
}`)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, `2
a
b
4
head
middle-1
middle-2
tail
ABC
1
0
4
4
b
4
property-head
property-tail
4
2.5
3.5
2
2.5
3.5
`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/Issue3096", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot, Config: "Debug"},
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let translated = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("All.Where(", translated, StringComparison.Ordinal)
        Assert.Contains("\"before\", ...", translated, StringComparison.Ordinal)
        Assert.Contains("Filtered, ...", translated, StringComparison.Ordinal)
        Assert.Contains("Empty, \"after\"}", translated, StringComparison.Ordinal)
        Assert.Contains("List[string](){", translated, StringComparison.Ordinal)
        Assert.Contains("[]float64{1", translated, StringComparison.Ordinal)
        Assert.Contains("List[float64](){", translated, StringComparison.Ordinal)
        Assert.Contains("...Temperatures", translated, StringComparison.Ordinal)
        Assert.Contains("Property = []string{\"property-head\", ...", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("__spread", translated, StringComparison.Ordinal)
        Assert.DoesNotContain(".AddRange(", translated, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
    }

    shared {
        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3096", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Debug", "Release"} {
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
