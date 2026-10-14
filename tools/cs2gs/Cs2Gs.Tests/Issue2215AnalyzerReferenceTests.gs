// <copyright file="Issue2215AnalyzerReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #2215: the Translate stage must capture a C# project's own
/// `<Analyzer>` reference paths, and the Compile stage must forward
/// them to gsc's `/analyzer:` flag, so gsc spawns `gsgen` itself and
/// the cs2gs-compiled assembly carries generator output the same way a real
/// MSBuild build of the source project would.
open class Issue2215AnalyzerReferenceTests {
    @Fact
    func ResolveGsgenTool_TriesGscLocationBeforeWorkingDirectoryFallback() {
        let testRoot = Path.Combine(
            AppContext.BaseDirectory,
            "ResolveGsgenTool_TriesGscLocationBeforeWorkingDirectoryFallback",
            Guid.NewGuid().ToString("N")
        )
        let gscRoot = Path.Combine(testRoot, "gsc-root")
        let gscDirectory = Path.Combine(gscRoot, "out", "bin", "Release", "Compiler")
        try {
            Directory.CreateDirectory(gscDirectory)
            let cwdRoot = Path.Combine(testRoot, "cwd-root")
            let cwdStart = Path.Combine(cwdRoot, "work")
            Directory.CreateDirectory(cwdStart)
            let cwdGsgen = Path.Combine(cwdRoot, "out", "bin", "Release", "Gsgen.Cli", "gsgen.dll")
            Directory.CreateDirectory(Path.GetDirectoryName(cwdGsgen)!!)
            File.WriteAllText(cwdGsgen, string.Empty)
            Assert.Equal(cwdGsgen, GscInvoker.ResolveGsgenTool(cwdGsgen, "Release"))
            Assert.Equal(cwdGsgen, GscInvoker.ResolveGsgenTool(nil, "Release", " ", cwdStart))
            let gscRelativeGsgen = Path.Combine(gscRoot, "out", "bin", "Release", "Gsgen.Cli", "gsgen.dll")
            Directory.CreateDirectory(Path.GetDirectoryName(gscRelativeGsgen)!!)
            File.WriteAllText(gscRelativeGsgen, string.Empty)
            Assert.Equal(gscRelativeGsgen, GscInvoker.ResolveGsgenTool(nil, "Release", gscDirectory, cwdStart))
            Assert.Equal(cwdGsgen, GscInvoker.ResolveGsgenTool(cwdGsgen, "Release", gscDirectory, cwdStart))
        } finally {
            TryDelete(testRoot)
        }
        Assert.False(Directory.Exists(testRoot))
    }

    @Fact
    async func Pipeline_ForwardsAnalyzerReference_GeneratorMemberReachesCompiledAssembly() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let gsgen string? = FindSiblingTool("Gsgen.Cli", "gsgen.dll")
        if compiler == nil || gsgen == nil {
            // Same gate every other e2e test in this file applies: build
            // GSharp.sln first.
            return
        }
        let generatorDll = GeneratorDllFactory.Value
        let projectDir = NewScratchDir("analyzer-ref")
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
        let projectPath = Path.Combine(projectDir, "Sample.csproj")
        File.WriteAllText(projectPath, (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
    <RootNamespace>Sample.App</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <Analyzer Include="` + "$generatorDll" + `" />
  </ItemGroup>
</Project>`))
        File.WriteAllText(Path.Combine(projectDir, "Foo.cs"), `namespace Sample.App;

[System.Obsolete]
public partial class Foo
{
}
`)
        // Sanity check the wiring at the Translate-stage level: the project's
        // own <Analyzer> item must surface as an analyzer reference path.
        let loaded = (
            await CSharpProjectLoader.LoadProjectWithReferencesAsync(projectPath, default(CancellationToken))
        )[0]
        Assert.Contains(
            loaded.AnalyzerReferencePaths,
            (p string) -> string.Equals(
                Path.GetFileName(p),
                Path.GetFileName(generatorDll),
                StringComparison.OrdinalIgnoreCase
            )
        )
        let outRoot = NewOutputRoot("analyzer-ref")
        let options = PipelineOptions{GscPath: compiler, GsgenPath: gsgen, OutputRoot: outRoot, CompileViaSdk: false}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let app = CorpusApp("test/AnalyzerRefApp", projectPath, TargetKind.Library)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        Assert.True(
            appResult.Succeeded,
            "Stage 1/2 must succeed for a project whose only gap is a generator-added member."
        )
        let dlls = Directory.GetFiles(outRoot, "Sample.dll", SearchOption.AllDirectories)
        let dll = Assert.Single(dlls)
        let assembly = Assembly.Load(File.ReadAllBytes(dll))
        let foo = assembly.GetTypes().Single((t Type) -> t.Name == "Foo")
        // "Greeting" only exists if gsc actually spawned gsgen against the
        // /analyzer: path the Compile stage forwarded, and folded the
        // back-translated .g.gs into this same compile.
        Assert.NotNull(foo.GetProperty("Greeting"))
    }

    /// Lazily compiles a real (cref:Microsoft.CodeAnalysis.IIncrementalGenerator)
    /// to a DLL on disk (once per test run): an attribute-driven generator
    /// that adds a `Greeting` property to any type decorated with
    /// `[Obsolete]`, wrapping its output in the target's own namespace
    /// (required so the back-translated G# part merges with the original
    /// declaration instead of colliding as a same-simple-name duplicate).
    private shared class GeneratorDllFactory {
        private let Lazy Lazy[string] = Lazy[string](Compile)
        prop Value string -> GeneratorDllFactory.Lazy.Value

        private func Compile() string {
            const Source = `
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
                "System.ObsoleteAttribute",
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
                sb.AppendLine("// <auto-generated/>");
                sb.AppendLine("#nullable enable");
                if (ns != null)
                {
                    sb.Append("namespace ").AppendLine(ns);
                    sb.AppendLine("{");
                }

                sb.Append("    partial class ").AppendLine(name);
                sb.AppendLine("    {");
                sb.Append("        public string Greeting => \"hi from \" + nameof(").Append(name).AppendLine(");");
                sb.AppendLine("    }");
                if (ns != null)
                {
                    sb.AppendLine("}");
                }

                spc.AddSource(name + ".g.cs", sb.ToString());
            });
        }
    }
}
`
            let tree = CSharpSyntaxTree.ParseText(Source, CSharpParseOptions(LanguageVersion.Latest))
            let references = RuntimeReferencePaths().Select(
                (p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Cs2GsAnalyzerRefTestGenerators",
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let dir = Directory.CreateTempSubdirectory("cs2gs_analyzer_gen_").FullName
            let path = Path.Combine(dir, "Cs2GsAnalyzerRefTestGenerators.dll")
            {
                using let stream = File.Create(path)
                let result = compilation.Emit(stream)
                if !result.Success {
                    let diagnostics = string.Join(
                        Environment.NewLine,
                        result.Diagnostics.Select((d Diagnostic) -> d.ToString())
                    )
                    throw InvalidOperationException((`Failed to compile test generator:
` + "$diagnostics"))
                }
            }
            return path
        }

        private func RuntimeReferencePaths()[]string {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let paths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly).ToList()
            paths.Add(typeof(IIncrementalGenerator).Assembly.Location)
            paths.Add(typeof(CSharpSyntaxTree).Assembly.Location)
            paths.Add(typeof(ClassDeclarationSyntax).Assembly.Location)
            return paths.Distinct().ToArray()
        }
    }

    shared {
        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        private func NewScratchDir(label string) string {
            let dir = Path.Combine(AppContext.BaseDirectory, "scratch-projects", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(dir)
            return dir
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
