// <copyright file="Issue2598AnonymousShapeConsistencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

class Issue2598AnonymousShapeConsistencyTests {
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
