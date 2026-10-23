// <copyright file="Issue2215AnalyzerFlagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
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

    /// ADR-0207: the GSHARP_GSGEN_TOOL variable names gsgen when no /gsgentool: switch is given. Before
    /// the change gsc ignored it and named the sibling path in its error.
    @Fact
    func Analyzer_GsgenToolEnvironment_IsUsedBeforeTheSiblingRule() {
        let message = RunAnalyzerAndReadError(
            []string{"/analyzer:/nonexistent/generator.dll"},
            gsgenTool: "/nonexistent/env-gsgen/gsgen.dll",
            sdkToolsDir: nil
        )
        Assert.Contains("GS9996", message)
        Assert.Contains("env-gsgen", message)
    }

    /// ADR-0207: the order is /gsgentool:, GSHARP_GSGEN_TOOL, /sdktoolsdir:, GSHARP_SDK_TOOLS_DIR.
    @Fact
    func Analyzer_GsgenResolutionOrder_PrefersTheMostExplicitInput() {
        let bySwitch = RunAnalyzerAndReadError(
            []string{"/analyzer:/nonexistent/generator.dll", "/gsgentool:/nonexistent/by-switch/gsgen.dll"},
            gsgenTool: "/nonexistent/by-env/gsgen.dll",
            sdkToolsDir: "/nonexistent/by-dir"
        )
        Assert.Contains("by-switch", bySwitch)
        let byEnvironmentTool = RunAnalyzerAndReadError(
            []string{"/analyzer:/nonexistent/generator.dll", "/sdktoolsdir:/nonexistent/by-switch-dir"},
            gsgenTool: "/nonexistent/by-env/gsgen.dll",
            sdkToolsDir: "/nonexistent/by-dir"
        )
        Assert.Contains("by-env", byEnvironmentTool)
        let bySdkSwitch = RunAnalyzerAndReadError(
            []string{"/analyzer:/nonexistent/generator.dll", "/sdktoolsdir:/nonexistent/by-switch-dir"},
            gsgenTool: nil,
            sdkToolsDir: "/nonexistent/by-env-dir"
        )
        Assert.Contains("by-switch-dir", bySdkSwitch)
        Assert.Contains("gsgen", bySdkSwitch)
        let bySdkEnvironment = RunAnalyzerAndReadError(
            []string{"/analyzer:/nonexistent/generator.dll"},
            gsgenTool: nil,
            sdkToolsDir: "/nonexistent/by-env-dir"
        )
        Assert.Contains("by-env-dir", bySdkEnvironment)
    }

    /// ADR-0207: with no explicit input gsc falls back to the sibling rule of the IL layout and tells
    /// the user how to give the location.
    @Fact
    func Analyzer_NoExplicitInput_NamesTheSwitch() {
        let message = RunAnalyzerAndReadError(
            []string{"/analyzer:/nonexistent/generator.dll"},
            gsgenTool: nil,
            sdkToolsDir: nil
        )
        Assert.Contains("gsgen was not found", message)
        Assert.Contains("/gsgentool:", message)
    }

    /// ADR-0207: gsgen found through the SDK tools folder runs the generator end to end, with the
    /// folder given by the /sdktoolsdir: switch and then by the GSHARP_SDK_TOOLS_DIR variable. The folder
    /// is not next to gsc, so the sibling rule cannot find it.
    @Fact
    func Analyzer_SdkToolsDir_FindsGsgenEndToEnd() {
        let tools = Directory.CreateTempSubdirectory("gsc_sdktools_").FullName
        let gsgenDir = Path.Combine(tools, "gsgen")
        Directory.CreateDirectory(gsgenDir)
        for file in Directory.GetFiles(Path.GetDirectoryName(GsgenToolPath)!!) {
            File.Copy(file, Path.Combine(gsgenDir, Path.GetFileName(file)), overwrite: true)
        }
        let prevEnvironment = Environment.GetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR")
        try {
            for useSwitch in []bool{true, false} {
                let tempDir = Directory.CreateTempSubdirectory("gsc_sdktools_run_").FullName
                let sample = Path.Combine(tempDir, "Foo.gs")
                File.WriteAllText(sample, "package MyLib\n\n@Obsolete\npartial class Foo {\n}\n")
                let outPath = Path.Combine(tempDir, "MyLib.dll")
                var dirValue string? = nil
                if !useSwitch {
                    dirValue = tools
                }
                Environment.SetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR", dirValue)
                let args = List[string]()
                args.Add(sample)
                args.Add("/analyzer:" + GeneratorDllFactory.Value)
                args.Add("/target:library")
                args.Add("/out:" + outPath)
                if useSwitch {
                    args.Add("/sdktoolsdir:" + tools)
                }
                using let outWriter = StringWriter()
                using let errWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(outWriter)
                Console.SetError(errWriter)
                var exit int32
                try {
                    exit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(exit == 0, "gsc failed (switch=$useSwitch): $errWriter")
                let assembly = EmittedFixture.Load(outPath)
                let foo = assembly.GetTypes().Single((t Type) -> t.Name == "Foo")
                Assert.NotNull(foo.GetProperty("Greeting"))
            }
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR", prevEnvironment)
            ReferenceResolver.SdkToolsDirectory = nil
            try {
                Directory.Delete(tools, recursive: true)
            } catch (IOException) { }
        }
    }

    /// ADR-0207: the bundled runtime lookup takes the portable copy from the SDK tools folder first.
    @Fact
    func BundledRuntime_SdkToolsDirectory_ReturnsThePortableCopy() {
        let tools = Directory.CreateTempSubdirectory("gsc_sdkruntime_").FullName
        try {
            let folder = Path.Combine(tools, "channels")
            Directory.CreateDirectory(folder)
            let copy = Path.Combine(folder, "Gsharp.Runtime.Channels.dll")
            File.Copy(PortableStandIn, copy)
            ReferenceResolver.SdkToolsDirectory = tools
            let found = ReferenceResolver.FindBundledChannelsRuntimePath("/nonexistent/gsc-dir")
            Assert.Equal(Path.GetFullPath(copy), found)
        } finally {
            ReferenceResolver.SdkToolsDirectory = nil
            Directory.Delete(tools, recursive: true)
        }
    }

    /// ADR-0207: an R2R image is never used as a bundled runtime. Its PE Machine is not 0x14C, so the
    /// lookup skips it. Before the change gsc copied whatever file it found.
    @Fact
    func BundledRuntime_ReadyToRunImage_IsSkipped() {
        let tools = Directory.CreateTempSubdirectory("gsc_sdkruntime_r2r_").FullName
        try {
            let folder = Path.Combine(tools, "channels")
            Directory.CreateDirectory(folder)
            let copy = Path.Combine(folder, "Gsharp.Runtime.Channels.dll")
            let bytes = File.ReadAllBytes(PortableStandIn)
            let peOffset = BitConverter.ToInt32(bytes, 0x3C)
            Assert.Equal(uint16(0x14C), BitConverter.ToUInt16(bytes, peOffset + 4))
            // The Machine of a linux-x64 ReadyToRun image: 0x8664 XOR 0x7B79.
            bytes[peOffset + 4] = uint8(0x1D)
            bytes[peOffset + 5] = uint8(0xFD)
            File.WriteAllBytes(copy, bytes)
            ReferenceResolver.SdkToolsDirectory = tools
            Assert.Null(ReferenceResolver.FindBundledChannelsRuntimePath("/nonexistent/gsc-dir"))
        } finally {
            ReferenceResolver.SdkToolsDirectory = nil
            Directory.Delete(tools, recursive: true)
        }
    }

    shared {
        // Resolved from the Gsgen.Cli ProjectReference, so it always points at the
        // gsgen.dll this same test run just built — no fragile path guessing.
        private let GsgenToolPath string = typeof(GsgenProgram).Assembly.Location

        // A portable IL assembly that the build just produced, used as a stand-in for a runtime file.
        private let PortableStandIn string = typeof(Issue2215AnalyzerFlagTests).Assembly.Location

        /// Runs `gsc` with /analyzer: and the given extra switches, and returns what it wrote to stderr.
        /// The two environment variables are set for the call and restored after it.
        private func RunAnalyzerAndReadError(extra []string, gsgenTool string?, sdkToolsDir string?) string {
            let prevTool = Environment.GetEnvironmentVariable("GSHARP_GSGEN_TOOL")
            let prevDir = Environment.GetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR")
            let sample = WriteTempGs("package P\n")
            using let err = StringWriter()
            let prevErr = Console.Error
            Console.SetError(err)
            try {
                Environment.SetEnvironmentVariable("GSHARP_GSGEN_TOOL", gsgenTool)
                Environment.SetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR", sdkToolsDir)
                let args = List[string]()
                args.Add(sample)
                args.AddRange(extra)
                let exit = Program.Main(args.ToArray())
                Assert.NotEqual(0, exit)
                return err.ToString()
            } finally {
                Console.SetError(prevErr)
                Environment.SetEnvironmentVariable("GSHARP_GSGEN_TOOL", prevTool)
                Environment.SetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR", prevDir)
                File.Delete(sample)
            }
        }

        private func WriteTempGs(source string) string {
            let path = Path.Combine(Path.GetTempPath(), "gsc_analyzer_test_${Guid.NewGuid():N}.gs")
            File.WriteAllText(path, source)
            return path
        }
    }
}
