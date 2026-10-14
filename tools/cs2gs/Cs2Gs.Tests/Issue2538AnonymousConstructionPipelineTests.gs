// <copyright file="Issue2538AnonymousConstructionPipelineTests.cs" company="GSharp">
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
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// Issue #2538: anonymous objects must use direct positional construction so
/// they remain valid in constructor delegation and object-typed API arguments.
class Issue2538AnonymousConstructionPipelineTests {
    @Fact
    func Translator_AnonymousObjects_UsePositionalConstructionInObjectTypedCalls() {
        let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Repro.cs", Source)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        let names = Regex.Matches(printed, "data class (AnonymousType\\d+_[0-9A-F]{16})\\(")
        Assert.Equal(2, names.Count)
        let envelopeType = names[0].Groups[1].Value
        let apiType = names[1].Groups[1].Value
        Assert.Contains(
            "convenience init() {${Environment.NewLine}        init($envelopeType(2538, \"anonymous\"))",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("Echo($apiType(true, 2))", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(envelopeType + "{", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(apiType + "{", printed, StringComparison.Ordinal)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            roundTrip!!.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
        )
    }

    @Fact
    async func Pipeline_ViaSdkDefault_AnonymousDelegationAndObjectApi_Compile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDir = Path.Combine(sourceRoot, "src", "Sample")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "Sample.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), Source)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/AnonymousConstruction", projectPath, TargetKind.Library)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        Assert.True(
            appResult.Succeeded,
            "Expected anonymous delegation and object-typed calls to compile. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status)
            )
        )
    }

    shared {
        private const Source string = `namespace Sample;

public sealed class Envelope
{
    public object Value { get; }

    public Envelope(object value)
    {
        Value = value;
    }

    public Envelope()
        : this(new { Id = 2538, Name = "anonymous" })
    {
    }
}

public static class Api
{
    public static object Echo(object value) => value;

    public static object Make() =>
        Echo(new { Ready = true, Count = 2 });
}`

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2538", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName)
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
