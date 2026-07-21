// <copyright file="Issue2598AnonymousShapeConsistencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2598AnonymousShapeConsistencyTests
{
    private const string ToolsSource = """
        namespace Demo.Tools;

        public static class ToolShapes
        {
            public static object Make() => new { active = "yes", sessions = 2 };
        }
        """;

    private const string HostingSource = """
        using Demo.Tools;

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
        }
        """;

    private const string ProgramSource = """
        using System;
        using Demo.Hosting;

        Console.WriteLine(Endpoint.Run());
        """;

    [Fact]
    public void Translator_UsesStableOrderedShapeNamesAcrossDocumentsAndProjects()
    {
        string[] translated = Translate(
            ("A.Tools.cs", ToolsSource),
            ("B.Hosting.cs", HostingSource));
        string toolsType = AnonymousTypeName(translated[0]);
        string hostingType = AnonymousTypeName(translated[1]);

        Assert.NotEqual(toolsType, hostingType);
        Assert.Contains($"{toolsType}(\"yes\", 2)", translated[0], StringComparison.Ordinal);
        Assert.Contains(
            $"{hostingType}(\"42\", \"A\", \"T\", \"done\", 1.0, \"ok\")",
            translated[1],
            StringComparison.Ordinal);

        const string SameShapeA = """
            namespace ProjectA;
            public static class A
            {
                public static object Make() => new { JobId = "1", Phase = "ready" };
            }
            """;
        const string SameShapeB = """
            namespace ProjectB;
            public static class B
            {
                public static object Make() => new { JobId = "2", Phase = "done" };
            }
            """;
        Assert.Equal(
            AnonymousTypeName(Translate(("A.cs", SameShapeA)).Single()),
            AnonymousTypeName(Translate(("B.cs", SameShapeB)).Single()));
    }

    [Fact]
    public async Task Pipeline_CrossPackageAnonymousShapes_CompileWithoutGS0144()
    {
        string compiler = FindCompiler();
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("projects");
        string projectPath = WriteProject(sourceRoot);
        string outputRoot = NewDirectory("pipeline");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2598", projectPath, TargetKind.Exe) });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(
            app.Succeeded,
            "Cross-package anonymous shapes must compile without GS0144. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    [Fact]
    public void Runtime_CrossPackageAnonymousShapes_ConstructTheDeclaredShape()
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);

        string[] translated = Translate(
            ("A.Tools.cs", ToolsSource),
            ("B.Hosting.cs", HostingSource));
        translated = translated
            .Append("package Demo.Hosting\n\nimport System\n\nConsole.WriteLine(Endpoint.Run())\n")
            .ToArray();
        string workDir = NewDirectory("runtime");
        var paths = translated
            .Select((source, index) =>
            {
                string path = Path.Combine(workDir, $"{index}.gs");
                File.WriteAllText(path, source);
                return path;
            })
            .ToArray();
        string assembly = Path.Combine(workDir, "Issue2598.dll");
        (int compileExit, string compileOutput) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{assembly}\" " +
                string.Join(" ", paths.Select(path => $"\"{path}\"")));

        Assert.True(
            compileExit == 0,
            "Translated fixture must compile without GS0144:\n" + compileOutput);
        (int runExit, string output) = RunDotnet($"\"{assembly}\"");
        Assert.Equal(0, runExit);
        Assert.Equal("42:done:ok", output.Trim());
    }

    private static string[] Translate(params (string FileName, string Source)[] sources)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(
            project.BoundWithoutErrors,
            "Fixture must bind as C#: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator();
        return project.Documents
            .Select(document =>
            {
                var context = new TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath);
                return GSharpPrinter.Print(translator.TranslateDocument(document, context));
            })
            .ToArray();
    }

    private static string AnonymousTypeName(string source)
    {
        Match match = Regex.Match(
            source,
            @"data class (AnonymousType\d+_[0-9A-F]{16})\(");
        Assert.True(match.Success, "Expected a synthesized anonymous type:\n" + source);
        return match.Groups[1].Value;
    }

    private static string WriteProject(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "Issue2598");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "Issue2598.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "A.Tools.cs"), ToolsSource);
        File.WriteAllText(Path.Combine(projectDir, "B.Hosting.cs"), HostingSource);
        File.WriteAllText(Path.Combine(projectDir, "Program.cs"), ProgramSource);
        return projectPath;
    }

    private static string NewDirectory(string category)
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2598",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var process = Process.Start(startInfo);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
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
