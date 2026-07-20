// <copyright file="Issue2538AnonymousConstructionPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2538: anonymous objects must use direct positional construction so
/// they remain valid in constructor delegation and object-typed API arguments.
/// </summary>
public sealed class Issue2538AnonymousConstructionPipelineTests
{
    private const string Source = """
        namespace Sample;

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
        }
        """;

    [Fact]
    public void Translator_AnonymousObjects_UsePositionalConstructionInObjectTypedCalls()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Repro.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains(
            "convenience init() {\n        init(AnonymousType0(2538, \"anonymous\"))",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("Echo(AnonymousType1(true, 2))", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousType0{", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousType1{", printed, StringComparison.Ordinal);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);
    }

    [Fact]
    public async Task Pipeline_ViaSdkDefault_AnonymousDelegationAndObjectApi_Compile()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null || repoRoot is null ||
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        string projectDir = Path.Combine(sourceRoot, "src", "Sample");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "Sample.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), Source);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp("test/AnonymousConstruction", projectPath, TargetKind.Library);
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };
        Assert.True(options.CompileViaSdk);

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        Assert.True(
            appResult.Succeeded,
            "Expected anonymous delegation and object-typed calls to compile. Stages: " +
                string.Join("; ", appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2538",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName,
                    "out",
                    "bin",
                    config,
                    projectDirName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
