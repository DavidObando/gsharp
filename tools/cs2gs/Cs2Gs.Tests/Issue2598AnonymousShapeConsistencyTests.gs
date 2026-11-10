// <copyright file="Issue2598AnonymousShapeConsistencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

class Issue2598AnonymousShapeConsistencyTests {
    @Theory
    @InlineData("where TOperation : MigrationOperation")
    @InlineData("where TOperation : class")
    @InlineData("where TOperation : notnull")
    func AnonymousProjectedStorage_PreservesImportedNonNullConstraints(constraint string) {
        let compiler = FindCompiler()
        Assert.NotNull(compiler)
        let workDir = NewDirectory("constraints")
        try {
            let contractPath = Path.Combine(workDir, "Contracts.dll")
            let contract = CSharpProjectLoader.LoadInMemory([](string, Source string){("Contracts.cs", `#nullable enable
namespace Contracts {
    public class MigrationOperation { }
    public sealed class AddColumnOperation : MigrationOperation { }
    public sealed class OperationBuilder<TOperation> CONSTRAINT { }
    public static class Builder {
        public static OperationBuilder<AddColumnOperation> Column<T>() => new();
    }
}`.Replace("CONSTRAINT", constraint))})
            Assert.True(contract.BoundWithoutErrors, string.Join(Environment.NewLine, contract.ErrorDiagnostics))
            {
                using let image = File.Create(contractPath)
                let emitted = contract.Compilation.Emit(image)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Consumer.cs", `#nullable disable
using Contracts;
public static class Consumer {
    public static object Make() => new { Id = Builder.Column<int>() };
}`)}, CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(contractPath)).ToArray())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Contains("OperationBuilder[AddColumnOperation]", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("OperationBuilder[AddColumnOperation?]", printed, StringComparison.Ordinal)
            let sourcePath = Path.Combine(workDir, "Consumer.gs")
            let outputPath = Path.Combine(workDir, "Consumer.dll")
            File.WriteAllText(sourcePath, printed)
            let (exit, output) = RunDotnet(
                "\"$compiler\" /target:library /targetframework:net10.0 /reference:\"$contractPath\" " +
                    "/out:\"$outputPath\" \"$sourcePath\""
            )
            Assert.True(exit == 0, "Translated anonymous storage must compile with zero errors:\n" + output)
            Assert.DoesNotContain("error GS0152", output, StringComparison.Ordinal)
        } finally {
            Directory.Delete(workDir, recursive: true)
        }
    }

    @Fact
    func ImportedNotNullAndDependentConstraints_PreserveNonNullArgumentsAndForwarding() {
        let compiler = FindCompiler()
        Assert.NotNull(compiler)
        let workDir = NewDirectory("dependent-constraints")
        try {
            let contractPath = Path.Combine(workDir, "Contracts.dll")
            let contract = CSharpProjectLoader.LoadInMemory([](string, Source string){("Contracts.cs", `#nullable enable
namespace Contracts {
    public class MigrationOperation { }
    public sealed class AddColumnOperation : MigrationOperation { }
    public sealed class OperationBuilder<TOperation> where TOperation : notnull {
        public TOperation Operation { get; }
        public OperationBuilder(TOperation operation) => Operation = operation;
    }
    public sealed class StrictPairBuilder<TBase, TOperation>
        where TBase : MigrationOperation
        where TOperation : TBase {
    }
    public sealed class FlexiblePairBuilder<TBase, TOperation>
        where TBase : MigrationOperation?
        where TOperation : TBase {
    }
    public static class Builder {
        public static void Consume<T>(T value) where T : notnull { }
        public static StrictPairBuilder<MigrationOperation, AddColumnOperation> StrictPair() => new();
        public static FlexiblePairBuilder<MigrationOperation, AddColumnOperation> FlexibleNonNull() => new();
        public static FlexiblePairBuilder<MigrationOperation?, AddColumnOperation?> FlexibleNullable() => new();
    }
}`)})
            Assert.True(contract.BoundWithoutErrors, string.Join(Environment.NewLine, contract.ErrorDiagnostics))
            {
                using let image = File.Create(contractPath)
                let emitted = contract.Compilation.Emit(image)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            let loaded = CSharpProjectLoader.LoadInMemory([](string, Source string){("Consumer.cs", `#nullable enable annotations
using Contracts;
public sealed class MigrationHolder<TOperation> where TOperation : notnull {
    private OperationBuilder<TOperation> item;
    public MigrationHolder(TOperation op) {
        item = new OperationBuilder<TOperation>(op);
    }
}
public static class Consumer {
    private static AddColumnOperation? MaybeNull() => null;
    public static void ConsumeChecked(AddColumnOperation op, bool reset) {
        if (reset) op = null;
        if (!reset) Builder.Consume(op);
        var local = MaybeNull();
        if (!reset) Builder.Consume(local);
    }
    public static object StrictAnon() => new { Pair = Builder.StrictPair() };
    public static object FlexibleAnon() => new { Pair = Builder.FlexibleNonNull() };
}`)}, CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(contractPath)).ToArray())
            Assert.True(loaded.BoundWithoutErrors, string.Join(Environment.NewLine, loaded.ErrorDiagnostics))
            let compilation = loaded.Compilation.WithOptions(
                loaded.Compilation.Options.WithNullableContextOptions(NullableContextOptions.Annotations)
            )
            let tree = Assert.Single(compilation.SyntaxTrees)
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Contains("class MigrationHolder[TOperation notnull]", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("OperationBuilder[AddColumnOperation?]", printed, StringComparison.Ordinal)
            Assert.Contains(
                "StrictPairBuilder[MigrationOperation, AddColumnOperation]",
                printed,
                StringComparison.Ordinal
            )
            Assert.Contains(
                "FlexiblePairBuilder[MigrationOperation?, AddColumnOperation?]",
                printed,
                StringComparison.Ordinal
            )
            let sourcePath = Path.Combine(workDir, "Consumer.gs")
            let outputPath = Path.Combine(workDir, "Consumer.dll")
            File.WriteAllText(sourcePath, printed)
            let (exit, output) = RunDotnet(
                "\"$compiler\" /target:library /targetframework:net10.0 /reference:\"$contractPath\" " +
                    "/out:\"$outputPath\" \"$sourcePath\""
            )
            Assert.True(exit == 0, "Translated consumer must compile with zero errors:\n" + output)
        } finally {
            Directory.Delete(workDir, recursive: true)
        }
    }

    @Fact
    func Translator_UsesStableOrderedShapeNamesAcrossDocumentsAndProjects() {
        let translated = Translate(("A.Tools.cs", ToolsSource), ("B.Hosting.cs", HostingSource))
        let toolsType = AnonymousTypeName(translated[0]!!)
        let hostingType = AnonymousTypeName(translated[1]!!)
        Assert.NotEqual(toolsType, hostingType)
        Assert.Contains("$toolsType(\"yes\", 2)", translated[0], StringComparison.Ordinal)
        Assert.Contains(
            "$hostingType(\"42\", \"A\", \"T\", \"done\", 1.0, \"ok\")",
            translated[1],
            StringComparison.Ordinal
        )
        const SameShapeA = `namespace ProjectA;
public static class A
{
    public static object Make() => new { JobId = "1", Phase = "ready" };
}`
        const SameShapeB = `namespace ProjectB;
public static class B
{
    public static object Make() => new { JobId = "2", Phase = "done" };
}`
        Assert.Equal(
            AnonymousTypeName(Translate(("A.cs", SameShapeA)).Single()!!),
            AnonymousTypeName(Translate(("B.cs", SameShapeB)).Single()!!)
        )
    }

    @Fact
    async func Pipeline_CrossPackageAnonymousShapes_CompileWithoutGS0144() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("projects")
        let projectPath = WriteProject(sourceRoot)
        let outputRoot = NewDirectory("pipeline")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2598", projectPath, TargetKind.Exe)})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            "Cross-package anonymous shapes must compile without GS0144. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    @Fact
    func Runtime_CrossPackageAnonymousShapes_ConstructTheDeclaredShape() {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        var translated = Translate(("A.Tools.cs", ToolsSource), ("B.Hosting.cs", HostingSource))
        translated = translated.Append(`package Demo.Hosting

import System

Console.WriteLine(Endpoint.Run())
`).ToArray()
        let workDir = NewDirectory("runtime")
        let paths = translated.Select(
            (source string, index int32) -> {
                let path = Path.Combine(workDir, "$index.gs")
                File.WriteAllText(path, source)
                return path
            }
        )
            .ToArray()
        let assembly = Path.Combine(workDir, "Issue2598.dll")
        let (compileExit, compileOutput) = RunDotnet(
            "\"$compiler\" /target:exe /out:\"$assembly\" " + string.Join(
                " ",
                paths.Select((path string) -> "\"$path\"")
            )
        )
        Assert.True(compileExit == 0, "Translated fixture must compile without GS0144:\n" + compileOutput)
        let (runExit, output) = RunDotnet("\"$assembly\"")
        Assert.Equal(0, runExit)
        Assert.Equal("42:done:ok", output.Trim())
    }

    shared {
        private const ToolsSource string = `namespace Demo.Tools;

public static class ToolShapes
{
    public static object Make() => new { active = "yes", sessions = 2 };
}`

        private const HostingSource string = `using Demo.Tools;

namespace Demo.Hosting;

public static class Endpoint
{
    public static string Run()
    {
        _ = ToolShapes.Make();
        var snapshot = new
        {
            jobId = "42",
            asin = "A",
            title = "T",
            phase = "done",
            progress = 1.0,
            message = "ok",
        };
        return snapshot.jobId + ":" + snapshot.phase + ":" + snapshot.message;
    }
}`

        private const ProgramSource string = `using System;
using Demo.Hosting;

Console.WriteLine(Endpoint.Run());`

        private func Translate(sources ...(FileName string, Source string))[]string? {
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(
                project.BoundWithoutErrors,
                "Fixture must bind as C#: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let translator = CSharpToGSharpTranslator()
            return project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    return GSharpPrinter.Print(translator.TranslateDocument(document, context))
                }
            )
                .ToArray()
        }

        private func AnonymousTypeName(source string) string {
            let match = Regex.Match(source, "data class (AnonymousType\\d+_[0-9A-F]{16})\\(")
            Assert.True(match.Success, "Expected a synthesized anonymous type:\n" + source)
            return match.Groups[1].Value
        }

        private func WriteProject(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let projectDir = Path.Combine(sourceRoot, "Issue2598")
            Directory.CreateDirectory(projectDir)
            let projectPath = Path.Combine(projectDir, "Issue2598.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(projectDir, "A.Tools.cs"), ToolsSource)
            File.WriteAllText(Path.Combine(projectDir, "B.Hosting.cs"), HostingSource)
            File.WriteAllText(Path.Combine(projectDir, "Program.cs"), ProgramSource)
            return projectPath
        }

        private func NewDirectory(category string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, category, "issue2598", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
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
