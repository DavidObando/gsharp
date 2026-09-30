// <copyright file="Issue4300NestedDeconstructionPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #4300 nested deconstruction driver coverage.</summary>
[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue4300NestedDeconstructionPipelineTests
{
    [Fact]
    public async Task NestedDeconstruction_TranslatesCompilesVerifiesAndPreservesOutput()
    {
        string compiler = FindCompiler();
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        Assert.True(
            compiler is not null,
            "The Release/Debug gsc.dll test dependency must exist.");
        if (repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, "Release") is null
            || !IlVerifyToolAvailable())
        {
            return;
        }

        string sourceRoot = null;
        string outputRoot = null;
        try
        {
            sourceRoot = NewDirectory("scratch-projects");
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
            string supportPath = Path.Combine(sourceRoot, "Cs2Gs.InMemory.dll");
            LoadedCSharpProject support = CSharpProjectLoader.LoadInMemory(
                new[]
                {
                    ("SideEffectingPair.cs", """
                        namespace Support;

                        public sealed class SideEffectingPair
                        {
                            public static int Calls;

                            public void Deconstruct(out int left, out int right)
                            {
                                Calls++;
                                left = 24;
                                right = 25;
                            }
                        }
                        """),
                },
                CSharpProjectLoader.RuntimeReferences());
            Assert.True(
                support.BoundWithoutErrors,
                string.Join(Environment.NewLine, support.ErrorDiagnostics));
            Microsoft.CodeAnalysis.Emit.EmitResult supportEmit;
            using (FileStream supportStream = File.Create(supportPath))
            {
                supportEmit = support.Compilation.Emit(supportStream);
            }

            Assert.True(
                supportEmit.Success,
                string.Join(
                    Environment.NewLine,
                    supportEmit.Diagnostics.Where(
                        diagnostic => diagnostic.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error)));

            string projectDirectory = Path.Combine(sourceRoot, "Issue4300");
            Directory.CreateDirectory(projectDirectory);
            string projectPath = Path.Combine(projectDirectory, "Issue4300.csproj");
            File.WriteAllText(projectPath, $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Exe</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <Nullable>enable</Nullable>
                  </PropertyGroup>
                  <ItemGroup>
                    <Reference Include="Cs2Gs.InMemory">
                      <HintPath>{supportPath}</HintPath>
                    </Reference>
                  </ItemGroup>
                </Project>
                """);
            File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), """
                using System;
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

                        ((GetTarget().Value, State.Values[GetIndex()]), existing) = GetValues();

                        var result = ((a, b), _) = ((14, 15), 16);
                        (long widened, int exact) = (17, 18);

                        int aTuple = 99;
                        int aValue = 98;
                        ((a, b), c) = ((19, 20), 21);

                        Console.WriteLine($"deconstruct:{SideEffectingPair.Calls}");
                        Console.WriteLine($"{declA},{declB},{declC}");
                        Console.WriteLine($"{fresh},{a},{b},{c},{d},{kept}");
                        Console.WriteLine($"{State.Target.Value},{State.Values[0]},{existing}");
                        Console.WriteLine($"{result.Item1.Item1},{result.Item1.Item2},{result.Item2}");
                        Console.WriteLine($"{widened},{exact},{aTuple},{aValue}");
                    }
                }
                """);
            string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
            File.WriteAllText(
                goldenPath,
                "target\nindex\nrhs\ndeconstruct:2\n1,2,3\n5,19,20,21,10,11\n21,22,23\n14,15,16\n17,18,99,98\n");

            outputRoot = NewDirectory("pipeline-tests");
            var app = new CorpusApp(
                "test/Issue4300",
                projectPath,
                TargetKind.Exe,
                stdoutGolden: goldenPath);
            var pipeline = new MigrationPipeline(
                new PipelineOptions
                {
                    GscPath = compiler,
                    OutputRoot = outputRoot,
                    SourceRoot = sourceRoot,
                    Config = "Release",
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

            Assert.DoesNotContain("__decon", translated, StringComparison.Ordinal);
            Assert.Contains("aTuple2", translated, StringComparison.Ordinal);
            Assert.Contains("aValue2", translated, StringComparison.Ordinal);
            Assert.Contains("let (keptValue, _) = (11, (12, 13))", translated, StringComparison.Ordinal);
            Assert.Contains("let (_, deconstructedTuple) = (0, SideEffectingPair())", translated, StringComparison.Ordinal);
            Assert.Contains("let (_, _) = deconstructedTuple", translated, StringComparison.Ordinal);
            Assert.Contains("let (_, _) = deconstructedTuple2", translated, StringComparison.Ordinal);
            Assert.NotEmpty(appResult.Stages);
            Assert.Equal(
                new[] { "translate", "compile", "ilverify", "test-parity" },
                appResult.Stages.Select(stage => stage.Stage).ToArray());
            Assert.Equal(
                new[] { "passed", "passed", "passed", "passed" },
                appResult.Stages.Select(stage => stage.Status).ToArray());
            Assert.True(
                appResult.Succeeded,
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        }
        finally
        {
            DeleteDirectory(outputRoot);
            DeleteDirectory(sourceRoot);
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
            "issue4300",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static void DeleteDirectory(string path)
    {
        if (path is not null && Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }
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
