// <copyright file="GsgenCliTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Gsgen.Cli
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis
import System.Runtime.InteropServices

/// ADR-0145 §A/§F: tests for the `gsgen` one-shot CLI. They drive
/// (cref:GsgenProgram.Run) in-process (no child process) and, for the
/// end-to-end case, compile a real Roslyn incremental generator to a DLL on
/// disk so the `/analyzer:` load path is exercised exactly as the SDK will.
open class GsgenCliTests : IDisposable {
    private let workDir string

    init() {
        this.workDir = Path.Combine(Path.GetTempPath(), "gsgen-cli-tests", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.workDir)
    }

    func Dispose() {
        try {
            Directory.Delete(this.workDir, recursive: true)
        } catch (IOException) { }
    }

    @Fact
    func NoAnalyzers_ReturnsZero_WritesEmptyManifest_NoFiles() {
        let outDir = Path.Combine(this.workDir, "gen")
        let manifest = Path.Combine(this.workDir, "manifest.txt")
        let gs = this.WriteGs("Foo.gs", `package App

partial class Foo {
}
`)
        let stdout = StringWriter()
        let exit = GsgenProgram.Run([]string{"/gs:$gs", "/out:$outDir", "/manifest:$manifest"}, stdout)
        Assert.Equal(0, exit)
        Assert.True(File.Exists(manifest))
        Assert.Equal(string.Empty, File.ReadAllText(manifest))
        Assert.False(Directory.Exists(outDir) && Directory.EnumerateFiles(outDir, "*.g.gs").Any())
        Assert.Equal(string.Empty, stdout.ToString())
    }

    @Fact
    func CleanupOnly_ExistingManifest_DeletesGeneratedFilesWithoutSources() {
        let outDir = Path.Combine(workDir, "gen")
        Directory.CreateDirectory(outDir)
        let generated = Path.Combine(outDir, "Removed.g.gs")
        let manifest = Path.Combine(workDir, "manifest.txt")
        File.WriteAllText(generated, "partial class Removed {}")
        File.WriteAllText(manifest, generated)
        let stdout = StringWriter()
        Assert.Equal(0, GsgenProgram.Run([]string{"/out:$outDir", "/manifest:$manifest"}, stdout))
        Assert.Equal(string.Empty, stdout.ToString())
        Assert.False(File.Exists(generated))
        Assert.Equal(string.Empty, File.ReadAllText(manifest))
    }

    @Theory
    @InlineData("/analyzer:generator.dll")
    @InlineData("/csfile:Foreign.cs")
    @InlineData("")
    func MissingSources_OutsideCleanup_PreservesRequiredValidationAndPreviousOutputs(option string) {
        let outDir = Path.Combine(workDir, "gen")
        Directory.CreateDirectory(outDir)
        let generated = Path.Combine(outDir, "Previous.g.gs")
        let manifest = Path.Combine(workDir, "manifest.txt")
        File.WriteAllText(generated, "partial class Previous {}")
        File.WriteAllText(manifest, generated)
        let args = List[string]{"/out:$outDir"}
        if option.Length > 0 {
            args.Add("/manifest:$manifest")
            args.Add(option)
        }
        let stdout = StringWriter()
        Assert.Equal(1, GsgenProgram.Run(args.ToArray(), stdout))
        Assert.Contains("at least one '/gs:", stdout.ToString())
        Assert.True(File.Exists(generated))
        Assert.Equal(generated, File.ReadAllText(manifest))
    }

    @Fact
    func ResponseFile_IsExpanded_LikeGsc() {
        let outDir = Path.Combine(this.workDir, "gen")
        let manifest = Path.Combine(this.workDir, "manifest.txt")
        let gs = this.WriteGs("Foo.gs", `package App

partial class Foo {
}
`)
        let rsp = Path.Combine(this.workDir, "gsgen.rsp")
        File.WriteAllLines(rsp, []string{"/gs:$gs", "/out:$outDir", "/manifest:$manifest"})
        let stdout = StringWriter()
        let exit = GsgenProgram.Run([]string{"@$rsp"}, stdout)
        Assert.Equal(0, exit)
        Assert.True(File.Exists(manifest))
    }

    @Fact
    func Parse_ExtractsAllFlags() {
        let notes = List[string]()
        let args = GsgenArgs.Parse(
            []string{
                "/gs:a.gs",
                "/gs:b.gs",
                "/r:ref1.dll",
                "/r:ref2.dll",
                "/analyzer:gen.dll",
                "/csfile:ThisAssembly.cs",
                "/out:/tmp/out",
                "/rootnamespace:My.Ns",
                "/manifest:/tmp/m.txt",
                "/bogus:ignored"
            },
            notes
        )
        Assert.Equal([]string{"a.gs", "b.gs"}, args.GsFiles)
        Assert.Equal([]string{"ref1.dll", "ref2.dll"}, args.References)
        Assert.Equal([]string{"gen.dll"}, args.AnalyzerPaths)
        Assert.Equal([]string{"ThisAssembly.cs"}, args.CsFiles)
        Assert.Equal("/tmp/out", args.OutDir)
        Assert.Equal("My.Ns", args.RootNamespace)
        Assert.Equal("/tmp/m.txt", args.ManifestPath)
        Assert.Single(notes)
        Assert.Contains("/bogus:ignored", notes[0])
    }

    @Fact
    func EndToEnd_RealGeneratorDll_WritesBackTranslatedPart() {
        let generatorDll = GeneratorDllFactory.Value
        let outDir = Path.Combine(this.workDir, "gen")
        let manifest = Path.Combine(this.workDir, "manifest.txt")
        let gs = this.WriteGs("Foo.gs", `package App

@Obsolete
partial class Foo {
}
`)
        let args = List[string]{"/gs:$gs", "/analyzer:$generatorDll", "/out:$outDir", "/manifest:$manifest"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.Equal(0, exit)
        let generated = Directory.EnumerateFiles(outDir, "*.g.gs").ToList()
        let single = Assert.Single(generated)
        let content = File.ReadAllText(single)
        Assert.Contains("partial class Foo", content)
        Assert.Contains("Greeting", content)
        // The manifest lists exactly the generated file.
        let manifestLines = File.ReadAllLines(manifest).Where((l string) -> l.Length > 0).ToList()
        let manifestEntry = Assert.Single(manifestLines)
        Assert.Equal(Path.GetFullPath(single), Path.GetFullPath(manifestEntry))
    }

    @Fact
    func EndToEnd_RealGeneratorDll_WithRefPackReferences_PrimitiveMemberKeepsCorrectType() {
        // Regression test (issue #2261 verification): when the CALLER already
        // supplies a complete REF-assembly closure — as the SDK's GsgenTask
        // does via @(ReferencePathWithRefAssemblies) for a real --via-sdk
        // build — BuildMetadataReferences must NOT additionally union in the
        // host's own IMPL assemblies (e.g. System.Private.CoreLib.dll from
        // the shared runtime). Mixing a framework's REF assemblies (from the
        // targeting pack, used here) with its IMPL assembly for the same
        // well-known types is a classic Roslyn "type exists in both ..."
        // (CS0433) trap that makes even System.String/System.Object
        // unresolvable (CS0518), silently degrading every primitive/string-
        // typed generator-produced member (e.g. CommunityToolkit MVVM's
        // [ObservableProperty] backing members) to the G# `object`
        // placeholder. RuntimeReferencePaths() (used by the sibling test
        // above) is IMPL-only and never reproduced this, which is why this
        // bug went undetected until a real --via-sdk Oahu.UI migration
        // surfaced it.
        let refPackPaths = RefPackReferencePaths()
        if refPackPaths.Count == 0 {
            return // Targeting pack not available in this environment; skip defensively.

        }
        let generatorDll = GeneratorDllFactory.Value
        let outDir = Path.Combine(this.workDir, "gen")
        let gs = this.WriteGs("Foo.gs", `package App

@Obsolete
partial class Foo {
}
`)
        let args = List[string]{"/gs:$gs", "/analyzer:$generatorDll", "/out:$outDir"}
        args.AddRange(refPackPaths.Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.Equal(0, exit)
        let generated = Directory.EnumerateFiles(outDir, "*.g.gs").ToList()
        let single = Assert.Single(generated)
        let content = File.ReadAllText(single)
        Assert.Contains("prop Greeting string", content)
        Assert.DoesNotContain("prop Greeting object", content)
    }

    @Fact
    func EndToEnd_SameGeneratorAssemblyFromTwoPackageRoots_RunsOnce() {
        let generatorDll = GeneratorDllFactory.Value
        let copiedGenerator = Path.Combine(this.workDir, "second-package-root", "generator.dll")
        Directory.CreateDirectory(Path.GetDirectoryName(copiedGenerator)!!)
        File.Copy(generatorDll, copiedGenerator)
        let outDir = Path.Combine(this.workDir, "gen")
        let gs = this.WriteGs("Foo.gs", `package App

@Obsolete
partial class Foo {
}
`)
        let args = List[string]{"/gs:$gs", "/analyzer:$generatorDll", "/analyzer:$copiedGenerator", "/out:$outDir"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let exit = GsgenProgram.Run(args.ToArray(), StringWriter())
        Assert.Equal(0, exit)
        Assert.Single(Directory.EnumerateFiles(outDir, "*.g.gs"))
    }

    @Fact
    func OrphanCleanup_DeletesStalePartNotRegenerated() {
        let generatorDll = GeneratorDllFactory.Value
        let outDir = Path.Combine(this.workDir, "gen")
        Directory.CreateDirectory(outDir)
        let stale = Path.Combine(outDir, "old.g.gs")
        File.WriteAllText(stale, `package App

partial class Old {
}
`)
        let gs = this.WriteGs("Foo.gs", `package App

@Obsolete
partial class Foo {
}
`)
        let args = List[string]{"/gs:$gs", "/analyzer:$generatorDll", "/out:$outDir"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.Equal(0, exit)
        Assert.False(File.Exists(stale), "Stale orphan .g.gs should have been deleted.")
        Assert.NotEmpty(Directory.EnumerateFiles(outDir, "*.g.gs"))
    }

    @Fact
    func MissingGsFile_ReturnsNonZero_EmitsGs9200_NoStackTrace() {
        let generatorDll = GeneratorDllFactory.Value
        let outDir = Path.Combine(this.workDir, "gen")
        let missing = Path.Combine(this.workDir, "does-not-exist.gs")
        let stdout = StringWriter()
        let exit = GsgenProgram.Run([]string{"/gs:$missing", "/analyzer:$generatorDll", "/out:$outDir"}, stdout)
        Assert.NotEqual(0, exit)
        let output = stdout.ToString()
        Assert.Contains("error GS9200", output)
        Assert.Matches("^gsgen\\(1,1\\): error GS9200:", output.Trim())
        Assert.DoesNotContain("   at ", output) // no stack-trace frames

    }

    @Fact
    func ForeignCsFile_NoAnalyzers_IsStillTranslated_AndFolded() {
        // Issue #2214: a stray .cs Compile item (standing in for Nerdbank.
        // GitVersioning's generated ThisAssembly.cs) must be translated even
        // when the project has NO generator packages at all — the common case
        // the ADR-0145 fast path already optimizes for generators.
        let outDir = Path.Combine(this.workDir, "gen")
        let manifest = Path.Combine(this.workDir, "manifest.txt")
        let gs = this.WriteGs("Foo.gs", `package App

func Foo() {
}
`)
        let cs = this.WriteCs("ThisAssembly.cs", `namespace App
{
    internal static class ThisAssembly
    {
        internal const string AssemblyFileVersion = "1.2.3.4";
    }
}
`)
        let args = List[string]{"/gs:$gs", "/csfile:$cs", "/out:$outDir", "/manifest:$manifest"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.Equal(0, exit)
        let generated = Directory.EnumerateFiles(outDir, "*.g.gs").ToList()
        let single = Assert.Single(generated)
        let content = File.ReadAllText(single)
        Assert.Contains("ThisAssembly", content)
        Assert.Contains("AssemblyFileVersion", content)
        Assert.Contains("1.2.3.4", content)
        AssertGeneratedSourceCompiles(content, "OrdinaryForeignFile")
        let manifestLines = File.ReadAllLines(manifest).Where((l string) -> l.Length > 0).ToList()
        let manifestEntry = Assert.Single(manifestLines)
        Assert.Equal(Path.GetFullPath(single), Path.GetFullPath(manifestEntry))
    }

    @Theory
    @InlineData(
        "AssemblyOnly.cs",
        "using System.Reflection;\n[assembly: AssemblyTitleAttribute(\"Oahu\")]",
        "System.Reflection.AssemblyTitleAttribute",
        nil
    )
    @InlineData(
        "ModuleOnly.cs",
        "using System;\n[module: CLSCompliantAttribute(true)]",
        nil,
        "System.CLSCompliantAttribute"
    )
    func ForeignCsFile_WithSingleCompilationUnitAttribute_WritesCompilableOutput(
        fileName string,
        source string,
        expectedAssemblyAttribute string?,
        expectedModuleAttribute string?
    ) {
        let outDir = Path.Combine(this.workDir, Path.GetFileNameWithoutExtension(fileName))
        let gs = this.WriteGs(fileName + ".gs", `package Probe

func Placeholder() {
}
`)
        let cs = this.WriteCs(fileName, source)
        let args = List[string]{"/gs:$gs", "/csfile:$cs", "/out:$outDir"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.True(exit == 0, stdout.ToString())
        let content = File.ReadAllText(Assert.Single(Directory.EnumerateFiles(outDir, "*.g.gs")))
        AssertGeneratedSourceCompiles(
            content,
            Path.GetFileNameWithoutExtension(fileName),
            expectedAssemblyAttribute,
            expectedModuleAttribute
        )
    }

    @Fact
    func ForeignCsFile_PreservesCompilationUnitAssemblyAttribute() {
        let outDir = Path.Combine(this.workDir, "gen")
        let gs = this.WriteGs("Input.gs", `package Probe

func Placeholder() {
}
`)
        let cs = this.WriteCs("Test2.cs", `using System.Reflection;

[assembly: System.Reflection.AssemblyTitleAttribute("Oahu")]

namespace Probe2
{
    internal class Holder
    {
        internal const string X = "y";
    }
}`)
        let args = List[string]{"/gs:$gs", "/csfile:$cs", "/out:$outDir"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.True(exit == 0, stdout.ToString())
        let content = File.ReadAllText(Assert.Single(Directory.EnumerateFiles(outDir, "*.g.gs")))
        Assert.Contains("package Probe2", content)
        Assert.Contains("import System.Reflection", content)
        Assert.Contains("@assembly:System.Reflection.AssemblyTitleAttribute(\"Oahu\")", content)
        Assert.Contains("internal class Holder", content)
        AssertGeneratedSourceCompiles(
            content,
            "AttributesAndType",
            expectedAssemblyAttribute: "System.Reflection.AssemblyTitleAttribute"
        )
    }

    @Fact
    func ForeignCsFile_WithOnlyFileAttributes_WritesCompilableOutput() {
        let outDir = Path.Combine(this.workDir, "gen")
        let gs = this.WriteGs("Input.gs", `package Probe

func Placeholder() {
}
`)
        let cs = this.WriteCs("AssemblyAttributes.cs", `using System;
using System.Reflection;

[assembly: System.Reflection.AssemblyTitleAttribute("Oahu")]
[module: System.CLSCompliantAttribute(true)]`)
        let args = List[string]{"/gs:$gs", "/csfile:$cs", "/out:$outDir"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.True(exit == 0, stdout.ToString())
        let content = File.ReadAllText(Assert.Single(Directory.EnumerateFiles(outDir, "*.g.gs")))
        Assert.Contains("import System", content)
        Assert.Contains("import System.Reflection", content)
        Assert.Contains("@assembly:System.Reflection.AssemblyTitleAttribute(\"Oahu\")", content)
        Assert.Contains("@module:System.CLSCompliantAttribute(true)", content)
        AssertGeneratedSourceCompiles(
            content,
            "BothFileAttributes",
            "System.Reflection.AssemblyTitleAttribute",
            "System.CLSCompliantAttribute"
        )
    }

    @Fact
    func ForeignCsFile_WithNoMembers_WritesNoOutput() {
        let outDir = Path.Combine(this.workDir, "gen-empty")
        let gs = this.WriteGs("Input.gs", `package Probe

func Placeholder() {
}
`)
        let cs = this.WriteCs("Empty.cs", "using System;\n")
        let args = List[string]{"/gs:$gs", "/csfile:$cs", "/out:$outDir"}
        args.AddRange(RuntimeReferencePaths().Select((p string) -> "/r:$p"))
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout)
        Assert.True(exit == 0, stdout.ToString())
        Assert.Empty(Directory.EnumerateFiles(outDir, "*.g.gs"))
    }

    @Fact
    func NoAnalyzersNoCsFiles_FastPath_Unaffected() {
        // Guard: a project with no generators AND no stray .cs (the universal
        // common case) must still take the zero-cost fast path.
        let outDir = Path.Combine(this.workDir, "gen")
        let manifest = Path.Combine(this.workDir, "manifest.txt")
        let gs = this.WriteGs("Foo.gs", `package App

partial class Foo {
}
`)
        let stdout = StringWriter()
        let exit = GsgenProgram.Run([]string{"/gs:$gs", "/out:$outDir", "/manifest:$manifest"}, stdout)
        Assert.Equal(0, exit)
        Assert.Equal(string.Empty, File.ReadAllText(manifest))
        Assert.False(Directory.Exists(outDir) && Directory.EnumerateFiles(outDir, "*.g.gs").Any())
    }

    private func WriteGs(name string, source string) string {
        let path = Path.Combine(this.workDir, name)
        File.WriteAllText(path, source)
        return path
    }

    private func WriteCs(name string, source string) string {
        let path = Path.Combine(this.workDir, name)
        File.WriteAllText(path, source)
        return path
    }

    /// Lazily compiles a real (cref:Microsoft.CodeAnalysis.IIncrementalGenerator)
    /// to a DLL on disk (once per test run) so the CLI's `/analyzer:` load
    /// path is validated end to end. Mirrors the attribute-driven shape of
    /// `GeneratorHostEndToEndTests.GreetingGenerator`.
    private shared class GeneratorDllFactory {
        private let Lazy Lazy[string] = Lazy[string](Compile)
        prop Value string -> GeneratorDllFactory.Lazy.Value

        private func Compile() string {
            const Source = `
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace GsgenTestGenerators
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
            let references = GsgenCliTests
                .RuntimeReferencePaths()
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                assemblyName: "GsgenTestGenerators",
                syntaxTrees: []Microsoft.CodeAnalysis.SyntaxTree{tree},
                references: references,
                options: CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let dllPath = Path.Combine(Path.GetTempPath(), "gsgen-cli-tests-gen", Guid.NewGuid().ToString("N") + ".dll")
            Directory.CreateDirectory(Path.GetDirectoryName(dllPath)!!)
            using let fs = FileStream(dllPath, FileMode.Create, FileAccess.Write)
            let emit = compilation.Emit(fs)
            if !emit.Success {
                let errors = string.Join(
                    "\n",
                    emit.Diagnostics.Where(
                        (d Microsoft.CodeAnalysis.Diagnostic) -> d.Severity == Microsoft
                            .CodeAnalysis
                            .DiagnosticSeverity
                            .Error
                    )
                )
                throw InvalidOperationException("Failed to compile test generator DLL:\n" + errors)
            }
            return dllPath
        }
    }

    shared {
        private func AssertGeneratedSourceCompiles(
            content string,
            assemblyName string,
            expectedAssemblyAttribute string? = nil,
            expectedModuleAttribute string? = nil
        ) {
            let tree = GsSyntaxTree.Parse(GsSourceText.From(content))
            Assert.Empty(tree.Diagnostics)
            using let pe = MemoryStream()
            let compilation = GsCompilation(tree){IsLibrary = true}
            let emit = compilation.Emit(pe, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            Assert.True(
                emit.Success,
                "generated file should compile: " + string.Join(
                    "; ",
                    emit.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                )
            )
            pe.Position = 0
            using let peReader = PEReader(pe, PEStreamOptions.LeaveOpen)
            let metadata = peReader.GetMetadataReader()
            if expectedAssemblyAttribute != nil {
                Assert.Contains(
                    expectedAssemblyAttribute,
                    GetAttributeTypeNames(metadata, metadata.GetAssemblyDefinition().GetCustomAttributes())
                )
            }
            if expectedModuleAttribute != nil {
                Assert.Contains(
                    expectedModuleAttribute,
                    GetAttributeTypeNames(metadata, metadata.GetModuleDefinition().GetCustomAttributes())
                )
            }
        }

        private func RuntimeReferencePaths() IReadOnlyList[string] {
            let tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty
            return tpa
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where((p string) -> p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
                .ToList()
        }

        /// Locates the `Microsoft.NETCore.App.Ref` targeting-pack directory
        /// alongside the running SDK and returns its REF-assembly DLLs — the same
        /// kind of reference-assembly-only closure MSBuild resolves into
        /// `@(ReferencePathWithRefAssemblies)` for a real SDK-style build,
        /// deliberately WITHOUT any IMPL assembly (no `System.Private.CoreLib.dll`
        /// from the shared runtime). Returns an empty list if the pack cannot be
        /// found so callers can skip defensively rather than fail on unusual
        /// installs.
        private func RefPackReferencePaths() IReadOnlyList[string] {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let dotnetRoot = Path.GetFullPath(Path.Combine(runtimeDir, "..", "..", ".."))
            let packsDir = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            if !Directory.Exists(packsDir) {
                return Array.Empty[string]()
            }
            let packVersionDir string? = Directory
                .GetDirectories(packsDir)
                .OrderByDescending((d string) -> d, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault()
            if packVersionDir == nil {
                return Array.Empty[string]()
            }
            let refRoot = Path.Combine(packVersionDir, "ref")
            if !Directory.Exists(refRoot) {
                return Array.Empty[string]()
            }
            let refDir string? = Directory
                .GetDirectories(refRoot)
                .OrderByDescending((d string) -> d, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault()
            return if refDir == nil {
                Array.Empty[string]()
            } else {
                Directory.GetFiles(refDir, "*.dll")
            }
        }

        private func GetAttributeTypeNames(
            metadata MetadataReader,
            attributes CustomAttributeHandleCollection
        ) IReadOnlyList[string] {
            let names = List[string]()
            for handle in attributes {
                let attribute = metadata.GetCustomAttribute(handle)
                if attribute.Constructor.Kind != HandleKind.MemberReference {
                    continue
                }
                let constructor = metadata.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                if constructor.Parent.Kind == HandleKind.TypeReference {
                    let type = metadata.GetTypeReference(TypeReferenceHandle(constructor.Parent))
                    names.Add(metadata.GetString(type.Namespace) + "." + metadata.GetString(type.Name))
                }
            }
            return names
        }
    }
}
