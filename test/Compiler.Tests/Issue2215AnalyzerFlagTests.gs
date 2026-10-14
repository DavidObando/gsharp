// <copyright file="Issue2215AnalyzerFlagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Gsgen.Cli
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2215: gsc's `/analyzer:<path>` flag spawns `gsgen` as a
/// sibling process (ADR-0027 — Roslyn never links into gsc itself) to run the
/// supplied generators before compiling, so any gsc caller — not just the SDK's
/// MSBuild target — gets generator output.
open class Issue2215AnalyzerFlagTests {
    @Fact
    func Analyzer_MissingValue_ReturnsError() {
        let sample = WriteTempGs("package P\n")
        using let err = StringWriter()
        let prevErr = Console.Error
        Console.SetError(err)
        try {
            let exit = Program.Main([]string{sample, "/analyzer:"})
            Assert.NotEqual(0, exit)
            Assert.Contains("/analyzer requires a path", err.ToString())
        } finally {
            Console.SetError(prevErr)
            File.Delete(sample)
        }
    }

    @Fact
    func Analyzer_GsgenToolNotFound_ReturnsErrorAndDoesNotCompile() {
        let sample = WriteTempGs("package P\n")
        using let err = StringWriter()
        let prevErr = Console.Error
        Console.SetError(err)
        try {
            let exit = Program.Main(
                []string{sample, "/analyzer:/nonexistent/generator.dll", "/gsgentool:/nonexistent/gsgen.dll"}
            )
            Assert.NotEqual(0, exit)
            Assert.Contains("GS9996", err.ToString())
            Assert.Contains("gsgen was not found", err.ToString())
        } finally {
            Console.SetError(prevErr)
            File.Delete(sample)
        }
    }

    @Fact
    func NoAnalyzer_DoesNotTouchGsgen_SameAsBaseline() {
        // Fast-path guard (requirement #3): omitting /analyzer entirely must
        // behave identically to today — a bogus /gsgentool: (which would fail
        // hard if gsgen were ever launched) must have zero effect.
        let sample = WriteTempGs(`package P

func Main() {
}
`)
        using let outWriter = StringWriter()
        let prevOut = Console.Out
        Console.SetOut(outWriter)
        try {
            let exit = Program.Main([]string{sample, "/gsgentool:/nonexistent/gsgen.dll"})
            Assert.Equal(0, exit)
        } finally {
            Console.SetOut(prevOut)
            File.Delete(sample)
        }
    }

    @Fact
    func Analyzer_EndToEnd_GeneratorMemberReachesCompiledAssembly() {
        let tempDir = Directory.CreateTempSubdirectory("gsc_analyzer_e2e_").FullName
        let sample = Path.Combine(tempDir, "Foo.gs")
        File.WriteAllText(sample, `package MyLib

@Obsolete
partial class Foo {
}
`)
        let outPath = Path.Combine(tempDir, "MyLib.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        var exit int32
        try {
            exit = Program.Main(
                []string{
                    sample,
                    "/analyzer:" + GeneratorDllFactory.Value,
                    "/gsgentool:" + GsgenToolPath,
                    "/target:library",
                    "/out:" + outPath
                }
            )
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
        }
        Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$outWriter" + `
stderr:
` + "$errWriter"))
        Assert.True(File.Exists(outPath))
        let assembly = EmittedFixture.Load(outPath)
        let foo = assembly.GetTypes().Single((t Type) -> t.Name == "Foo")
        // "Greeting" only exists on Foo if gsc actually ran the generator (via
        // gsgen) and folded its back-translated .g.gs into this compilation.
        Assert.NotNull(foo.GetProperty("Greeting"))
        try {
            Directory.Delete(tempDir, recursive: true)
        } catch (IOException) { }
    }

    /// Regression test for the PR #2221 rubber-duck review's blocking finding:
    /// gsc wrote unquoted paths into gsgen's `.gsgen.rsp`, so a source
    /// file, analyzer, or output directory under a path containing a space
    /// (e.g. Windows `C:\Users\John Smith\...`) got split into two bogus
    /// tokens by gsgen's `TokenizeResponseFileLine` whitespace splitter,
    /// failing with "unknown flag"/"file not found". This must fail before the
    /// rsp-quoting fix and pass after.
    @Fact
    func Analyzer_EndToEnd_PathsWithSpaces_GeneratorMemberReachesCompiledAssembly() {
        let tempDir = Path.Combine(Path.GetTempPath(), "gsc test " + Guid.NewGuid().ToString())
        Directory.CreateDirectory(tempDir)
        let sample = Path.Combine(tempDir, "Foo Bar.gs")
        File.WriteAllText(sample, `package MyLib

@Obsolete
partial class Foo {
}
`)
        let outPath = Path.Combine(tempDir, "My Lib.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        var exit int32
        try {
            exit = Program.Main(
                []string{
                    sample,
                    "/analyzer:" + GeneratorDllFactory.ValueWithSpace,
                    "/gsgentool:" + GsgenToolPath,
                    "/target:library",
                    "/out:" + outPath
                }
            )
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
        }
        Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$outWriter" + `
stderr:
` + "$errWriter"))
        Assert.True(File.Exists(outPath))
        let assembly = EmittedFixture.Load(outPath)
        let foo = assembly.GetTypes().Single((t Type) -> t.Name == "Foo")
        // Only present if gsgen actually ran (paths tokenized correctly) and
        // its output was folded back into this compilation.
        Assert.NotNull(foo.GetProperty("Greeting"))
        try {
            Directory.Delete(tempDir, recursive: true)
        } catch (IOException) { }
    }

    /// Lazily compiles a real (cref:Microsoft.CodeAnalysis.IIncrementalGenerator)
    /// to a DLL on disk (once per test run), mirroring
    /// `GsgenCliTests.GeneratorDllFactory` in
    /// `GSharp.GeneratorHost.Tests` — an attribute-driven generator that
    /// adds a `Greeting` property to any type decorated with
    /// `[Obsolete]`.
    private shared class GeneratorDllFactory {
        private let Lazy Lazy[string] = Lazy[string](() -> Compile("gsc_analyzer_gen_"))

        // Same generator, compiled under a temp directory whose name contains
        // a space — reproduces issue #2221's rsp-quoting bug (gsgen's
        // tokenizer split gsc's unquoted /analyzer: path on the space).
        private let LazyWithSpace Lazy[string] = Lazy[string](() -> Compile("gsc analyzer gen "))

        prop Value string -> GeneratorDllFactory.Lazy.Value
        prop ValueWithSpace string -> LazyWithSpace.Value

        private func Compile(tempDirPrefix string) string {
            const Source = (`
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace GscAnalyzerFlagTestGenerators
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
                // Must wrap in the target's own namespace (mirroring gsc's
                // /analyzer:-forwarded /r: package) — an un-namespaced partial
                // is a DIFFERENT (global-namespace) type from ` + "`" + `MyLib.Foo` + "`" + `, so
                // back-translation would emit it as a separate, colliding G#
                // declaration (GS0102) instead of a real partial part.
                string ns = symbol.ContainingNamespace is { IsGlobalNamespace: false } n
                    ? n.ToDisplayString()
                    : null;
                string name = symbol.Name;
                var sb = new StringBuilder();
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
`)
            let tree = CSharpSyntaxTree.ParseText(Source, CSharpParseOptions(LanguageVersion.Latest))
            let references = RuntimeReferencePaths().Select(
                (p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "GscAnalyzerFlagTestGenerators",
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let dir = Directory.CreateTempSubdirectory(tempDirPrefix).FullName
            let path = Path.Combine(dir, "GscAnalyzerFlagTestGenerators.dll")
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

        private func RuntimeReferencePaths() IReadOnlyList[string] {
            let tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty
            return tpa
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where((p string) -> p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
                .ToList()
        }
    }

    shared {
        // Resolved from the Gsgen.Cli ProjectReference, so it always points at the
        // gsgen.dll this same test run just built — no fragile path guessing.
        private let GsgenToolPath string = typeof(GsgenProgram).Assembly.Location

        private func WriteTempGs(source string) string {
            let path = Path.Combine(Path.GetTempPath(), "gsc_analyzer_test_${Guid.NewGuid():N}.gs")
            File.WriteAllText(path, source)
            return path
        }
    }
}
