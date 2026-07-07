// <copyright file="Issue2215AnalyzerReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2215: the Translate stage must capture a C# project's own
/// <c>&lt;Analyzer&gt;</c> reference paths, and the Compile stage must forward
/// them to gsc's <c>/analyzer:</c> flag, so gsc spawns <c>gsgen</c> itself and
/// the cs2gs-compiled assembly carries generator output the same way a real
/// MSBuild build of the source project would.
/// </summary>
public class Issue2215AnalyzerReferenceTests
{
    [Fact]
    public async Task Pipeline_ForwardsAnalyzerReference_GeneratorMemberReachesCompiledAssembly()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string gsgen = FindSiblingTool("Gsgen.Cli", "gsgen.dll");
        if (compiler is null || gsgen is null)
        {
            // Same gate every other e2e test in this file applies: build
            // GSharp.sln first.
            return;
        }

        string generatorDll = GeneratorDllFactory.Value;

        string projectDir = NewScratchDir("analyzer-ref");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Sample.csproj");
        File.WriteAllText(projectPath, $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
                <RootNamespace>Sample.App</RootNamespace>
              </PropertyGroup>
              <ItemGroup>
                <Analyzer Include="{generatorDll}" />
              </ItemGroup>
            </Project>
            """);

        File.WriteAllText(
            Path.Combine(projectDir, "Foo.cs"),
            "namespace Sample.App;\n\n[System.Obsolete]\npublic partial class Foo\n{\n}\n");

        // Sanity check the wiring at the Translate-stage level: the project's
        // own <Analyzer> item must surface as an analyzer reference path.
        LoadedCSharpProject loaded = (await CSharpProjectLoader
            .LoadProjectWithReferencesAsync(projectPath, default))[0];
        Assert.Contains(
            loaded.AnalyzerReferencePaths,
            p => string.Equals(Path.GetFileName(p), Path.GetFileName(generatorDll), StringComparison.OrdinalIgnoreCase));

        string outRoot = NewOutputRoot("analyzer-ref");
        var options = new PipelineOptions { GscPath = compiler, GsgenPath = gsgen, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        var app = new CorpusApp("test/AnalyzerRefApp", projectPath, TargetKind.Library);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        Assert.True(appResult.Succeeded, "Stage 1/2 must succeed for a project whose only gap is a generator-added member.");

        string[] dlls = Directory.GetFiles(outRoot, "Sample.dll", SearchOption.AllDirectories);
        string dll = Assert.Single(dlls);

        Assembly assembly = Assembly.Load(File.ReadAllBytes(dll));
        Type foo = assembly.GetTypes().Single(t => t.Name == "Foo");

        // "Greeting" only exists if gsc actually spawned gsgen against the
        // /analyzer: path the Compile stage forwarded, and folded the
        // back-translated .g.gs into this same compile.
        Assert.NotNull(foo.GetProperty("Greeting"));
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string dir = Path.Combine(AppContext.BaseDirectory, "scratch-projects", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>
    /// Lazily compiles a real <see cref="Microsoft.CodeAnalysis.IIncrementalGenerator"/>
    /// to a DLL on disk (once per test run): an attribute-driven generator
    /// that adds a <c>Greeting</c> property to any type decorated with
    /// <c>[Obsolete]</c>, wrapping its output in the target's own namespace
    /// (required so the back-translated G# part merges with the original
    /// declaration instead of colliding as a same-simple-name duplicate).
    /// </summary>
    private static class GeneratorDllFactory
    {
        private static readonly Lazy<string> Lazy = new(Compile);

        public static string Value => Lazy.Value;

        private static string Compile()
        {
            const string Source = @"
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2GsAnalyzerRefTestGenerators
{
    [Generator]
    public sealed class GreetingGenerator : IIncrementalGenerator
    {
        public void Initialize(IncrementalGeneratorInitializationContext context)
        {
            var classes = context.SyntaxProvider.ForAttributeWithMetadataName(
                ""System.ObsoleteAttribute"",
                predicate: static (node, _) => node is ClassDeclarationSyntax,
                transform: static (ctx, _) => (INamedTypeSymbol)ctx.TargetSymbol);

            context.RegisterSourceOutput(classes, static (spc, symbol) =>
            {
                string ns = symbol.ContainingNamespace is { IsGlobalNamespace: false } n
                    ? n.ToDisplayString()
                    : null;
                string name = symbol.Name;
                var sb = new StringBuilder();

                // Real-world generators (Issue #2215's motivating case) mark
                // their output with the standard auto-generated header so
                // CSharpProjectLoader.IsGeneratedSource correctly treats it as
                // generated (not hand-authored) and skips translating it
                // directly — gsc's own /analyzer:-triggered gsgen run is what
                // is meant to reproduce this member in the cs2gs output.
                sb.AppendLine(""// <auto-generated/>"");
                sb.AppendLine(""#nullable enable"");
                if (ns != null)
                {
                    sb.Append(""namespace "").AppendLine(ns);
                    sb.AppendLine(""{"");
                }

                sb.Append(""    partial class "").AppendLine(name);
                sb.AppendLine(""    {"");
                sb.Append(""        public string Greeting => \""hi from \"" + nameof("").Append(name).AppendLine("");"");
                sb.AppendLine(""    }"");
                if (ns != null)
                {
                    sb.AppendLine(""}"");
                }

                spc.AddSource(name + "".g.cs"", sb.ToString());
            });
        }
    }
}
";
            var tree = CSharpSyntaxTree.ParseText(Source, new CSharpParseOptions(LanguageVersion.Latest));
            var references = RuntimeReferencePaths()
                .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
                .ToList();

            var compilation = CSharpCompilation.Create(
                "Cs2GsAnalyzerRefTestGenerators",
                new[] { tree },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            var dir = Directory.CreateTempSubdirectory("cs2gs_analyzer_gen_").FullName;
            var path = Path.Combine(dir, "Cs2GsAnalyzerRefTestGenerators.dll");

            using (var stream = File.Create(path))
            {
                var result = compilation.Emit(stream);
                if (!result.Success)
                {
                    var diagnostics = string.Join(
                        Environment.NewLine,
                        result.Diagnostics.Select(d => d.ToString()));
                    throw new InvalidOperationException($"Failed to compile test generator:\n{diagnostics}");
                }
            }

            return path;
        }

        private static string[] RuntimeReferencePaths()
        {
            string runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
            var paths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly).ToList();

            paths.Add(typeof(IIncrementalGenerator).Assembly.Location);
            paths.Add(typeof(CSharpSyntaxTree).Assembly.Location);
            paths.Add(typeof(ClassDeclarationSyntax).Assembly.Location);

            return paths.Distinct().ToArray();
        }
    }
}
