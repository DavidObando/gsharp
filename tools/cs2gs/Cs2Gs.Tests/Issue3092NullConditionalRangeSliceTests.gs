// <copyright file="Issue3092NullConditionalRangeSliceTests.cs" company="GSharp">
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
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #3092: a range nested under conditional element access keeps G#'s
/// native `value?[start..end]` form.
@Collection("IlVerifyPipeline")
class Issue3092NullConditionalRangeSliceTests {
    @Fact
    func ConditionalRange_UsesCanonicalNativeSyntaxWithoutSpills() {
        let printed = Translate(Source)
        Assert.Contains("hash?[..12]", printed, StringComparison.Ordinal)
        Assert.Contains("Receiver(\"abcdef\")?[Start()..End()]", printed, StringComparison.Ordinal)
        Assert.Contains("numbers?[1..3]", printed, StringComparison.Ordinal)
        Assert.Contains("segment?[1..3]", printed, StringComparison.Ordinal)
        Assert.Contains("memory?[1..3]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    @Fact
    async func ConditionalRange_RoundTripsCompilesVerifiesAndRuns() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil ||
            !IlVerifyToolAvailable() {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3092")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue3092.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), Source)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, ExpectedOutput.Replace("\r\n", "\n"))
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/Issue3092", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("hash?[..12]", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", emitted, StringComparison.Ordinal)
        AssertRoundTrip(emitted)
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
        private const Source string = `#nullable enable
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
}`

        private const ExpectedOutput string = `prefix  suffix
prefix 0123456789ab suffix
prefix 0123456789ab suffix
bounds
R<nil>
RSEbcd
20,30
2
2`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }

        private func AssertRoundTrip(printed string) {
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                string.Join(Environment.NewLine, roundTrip!!.Errors) + Environment.NewLine + printed
            )
        }

        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3092", Guid.NewGuid().ToString("N"))
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
