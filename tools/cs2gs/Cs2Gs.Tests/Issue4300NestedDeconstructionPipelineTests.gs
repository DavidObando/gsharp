// <copyright file="Issue4300NestedDeconstructionPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Emit
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #4300 nested deconstruction driver coverage.
@Collection("IlVerifyPipeline")
class Issue4300NestedDeconstructionPipelineTests {
    @Fact
    async func NestedDeconstruction_TranslatesCompilesVerifiesAndPreservesOutput() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        Assert.True(compiler != nil, "The Release/Debug gsc.dll test dependency must exist.")
        if repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, "Release") == nil ||
            !IlVerifyToolAvailable() {
            return
        }
        var sourceRoot string? = nil
        var outputRoot string? = nil
        try {
            sourceRoot = NewDirectory("scratch-projects")
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let supportPath = Path.Combine(sourceRoot, "Cs2Gs.InMemory.dll")
            let support = CSharpProjectLoader.LoadInMemory([](string, string){("SideEffectingPair.cs", `namespace Support;

public sealed class SideEffectingPair
{
    public static int Calls;

    public void Deconstruct(out int left, out int right)
    {
        Calls++;
        left = 24;
        right = 25;
    }
}`)}, CSharpProjectLoader.RuntimeReferences())
            Assert.True(support.BoundWithoutErrors, string.Join(Environment.NewLine, support.ErrorDiagnostics))
            var supportEmit EmitResult
            {
                using let supportStream = File.Create(supportPath)
                supportEmit = support.Compilation.Emit(supportStream)
            }
            Assert.True(
                supportEmit.Success,
                string.Join(
                    Environment.NewLine,
                    supportEmit.Diagnostics.Where(
                        (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
                    )
                )
            )
            let projectDirectory = Path.Combine(sourceRoot, "Issue4300")
            Directory.CreateDirectory(projectDirectory)
            let projectPath = Path.Combine(projectDirectory, "Issue4300.csproj")
            File.WriteAllText(projectPath, (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="Cs2Gs.InMemory">
      <HintPath>` + "$supportPath" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`))
            File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System;
using Support;

public sealed class Box
{
    public int Value;
}

public static class State
{
    public static readonly Box Target = new();
    public static readonly int[] Values = new int[1];
}

public static class Program
{
    private static Box GetTarget()
    {
        Console.WriteLine("target");
        return State.Target;
    }

    private static int GetIndex()
    {
        Console.WriteLine("index");
        return 0;
    }

    private static ((int, int), int) GetValues()
    {
        Console.WriteLine("rhs");
        return ((21, 22), 23);
    }

    public static void Main()
    {
        var (declA, (declB, declC)) = (1, (2, 3));

        int existing = 0;
        (existing, (var fresh, _)) = (4, (5, 6));

        int a = 0;
        int b = 0;
        int c = 0;
        int d = 0;
        (a, (b, (c, d))) = (7, (8, (9, 10)));

        int kept = 0;
        (kept, (_, _)) = (11, (12, 13));

        var (_, (_, _)) = (0, new SideEffectingPair());
        int discardExisting = 0;
        (discardExisting, (_, _)) = (0, new SideEffectingPair());
        int deepKept = 0;
        (((_, _), _), deepKept) = ((new SideEffectingPair(), 3), 4);

        ((GetTarget().Value, State.Values[GetIndex()]), existing) = GetValues();

        var result = ((a, b), _) = ((14, 15), 16);
        (long widened, int exact) = (17, 18);

        int aTuple = 99;
        int aValue = 98;
        ((a, b), c) = ((19, 20), 21);

        Console.WriteLine($"deconstruct:{SideEffectingPair.Calls},{deepKept}");
        Console.WriteLine($"{declA},{declB},{declC}");
        Console.WriteLine($"{fresh},{a},{b},{c},{d},{kept}");
        Console.WriteLine($"{State.Target.Value},{State.Values[0]},{existing}");
        Console.WriteLine($"{result.Item1.Item1},{result.Item1.Item2},{result.Item2}");
        Console.WriteLine($"{widened},{exact},{aTuple},{aValue}");
    }
}`)
            let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
            File.WriteAllText(goldenPath, `target
index
rhs
deconstruct:3,4
1,2,3
5,19,20,21,10,11
21,22,23
14,15,16
17,18,99,98
`)
            outputRoot = NewDirectory("pipeline-tests")
            let app = CorpusApp("test/Issue4300", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
            let pipeline = MigrationPipeline(
                PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot, Config: "Release"},
                []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
            )
            let result = await pipeline.RunAsync([]CorpusApp{app})
            let appResult = Assert.Single(result.Apps)
            let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
            let translated = string.Join(
                Environment.NewLine,
                Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
            )
            Assert.DoesNotContain("__decon", translated, StringComparison.Ordinal)
            Assert.Contains("aTuple2", translated, StringComparison.Ordinal)
            Assert.Contains("aValue2", translated, StringComparison.Ordinal)
            Assert.Contains("let (keptValue, _) = (11, (12, 13))", translated, StringComparison.Ordinal)
            Assert.Contains(
                "let (_, deconstructedTuple) = (0, SideEffectingPair())",
                translated,
                StringComparison.Ordinal
            )
            Assert.Contains("let (_, _) = deconstructedTuple", translated, StringComparison.Ordinal)
            Assert.Contains("let (_, _) = deconstructedTuple2", translated, StringComparison.Ordinal)
            Assert.NotEmpty(appResult.Stages)
            Assert.Equal(
                []string{"translate", "compile", "ilverify", "test-parity"},
                appResult.Stages.Select((stage StageResult) -> stage.Stage).ToArray()
            )
            Assert.Equal(
                []string{"passed", "passed", "passed", "passed"},
                appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
            )
            Assert.True(
                appResult.Succeeded,
                string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
            )
        } finally {
            DeleteDirectory(outputRoot)
            DeleteDirectory(sourceRoot)
        }
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
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue4300", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func DeleteDirectory(path string?) {
            if path != nil && Directory.Exists(path) {
                Directory.Delete(path, recursive: true)
            }
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
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
