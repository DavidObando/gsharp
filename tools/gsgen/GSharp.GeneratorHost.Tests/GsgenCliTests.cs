// <copyright file="GsgenCliTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Gsgen.Cli;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0145 §A/§F: tests for the <c>gsgen</c> one-shot CLI. They drive
/// <see cref="GsgenProgram.Run"/> in-process (no child process) and, for the
/// end-to-end case, compile a real Roslyn incremental generator to a DLL on
/// disk so the <c>/analyzer:</c> load path is exercised exactly as the SDK will.
/// </summary>
public class GsgenCliTests : IDisposable
{
    private readonly string workDir;

    public GsgenCliTests()
    {
        this.workDir = Path.Combine(Path.GetTempPath(), "gsgen-cli-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.workDir);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(this.workDir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void NoAnalyzers_ReturnsZero_WritesEmptyManifest_NoFiles()
    {
        var outDir = Path.Combine(this.workDir, "gen");
        var manifest = Path.Combine(this.workDir, "manifest.txt");
        var gs = this.WriteGs("Foo.gs", "package App\n\npartial class Foo {\n}\n");

        var stdout = new StringWriter();
        int exit = GsgenProgram.Run(
            new[] { $"/gs:{gs}", $"/out:{outDir}", $"/manifest:{manifest}" },
            stdout);

        Assert.Equal(0, exit);
        Assert.True(File.Exists(manifest));
        Assert.Equal(string.Empty, File.ReadAllText(manifest));
        Assert.False(Directory.Exists(outDir) && Directory.EnumerateFiles(outDir, "*.g.gs").Any());
        Assert.Equal(string.Empty, stdout.ToString());
    }

    [Fact]
    public void ResponseFile_IsExpanded_LikeGsc()
    {
        var outDir = Path.Combine(this.workDir, "gen");
        var manifest = Path.Combine(this.workDir, "manifest.txt");
        var gs = this.WriteGs("Foo.gs", "package App\n\npartial class Foo {\n}\n");
        var rsp = Path.Combine(this.workDir, "gsgen.rsp");
        File.WriteAllLines(rsp, new[] { $"/gs:{gs}", $"/out:{outDir}", $"/manifest:{manifest}" });

        var stdout = new StringWriter();
        int exit = GsgenProgram.Run(new[] { $"@{rsp}" }, stdout);

        Assert.Equal(0, exit);
        Assert.True(File.Exists(manifest));
    }

    [Fact]
    public void Parse_ExtractsAllFlags()
    {
        var notes = new List<string>();
        var args = GsgenArgs.Parse(
            new[]
            {
                "/gs:a.gs",
                "/gs:b.gs",
                "/r:ref1.dll",
                "/r:ref2.dll",
                "/analyzer:gen.dll",
                "/csfile:ThisAssembly.cs",
                "/out:/tmp/out",
                "/rootnamespace:My.Ns",
                "/manifest:/tmp/m.txt",
                "/bogus:ignored",
            },
            notes);

        Assert.Equal(new[] { "a.gs", "b.gs" }, args.GsFiles);
        Assert.Equal(new[] { "ref1.dll", "ref2.dll" }, args.References);
        Assert.Equal(new[] { "gen.dll" }, args.AnalyzerPaths);
        Assert.Equal(new[] { "ThisAssembly.cs" }, args.CsFiles);
        Assert.Equal("/tmp/out", args.OutDir);
        Assert.Equal("My.Ns", args.RootNamespace);
        Assert.Equal("/tmp/m.txt", args.ManifestPath);
        Assert.Single(notes);
        Assert.Contains("/bogus:ignored", notes[0]);
    }

    [Fact]
    public void EndToEnd_RealGeneratorDll_WritesBackTranslatedPart()
    {
        string generatorDll = GeneratorDllFactory.Value;

        var outDir = Path.Combine(this.workDir, "gen");
        var manifest = Path.Combine(this.workDir, "manifest.txt");
        var gs = this.WriteGs("Foo.gs", "package App\n\n@Obsolete\npartial class Foo {\n}\n");

        var args = new List<string>
        {
            $"/gs:{gs}",
            $"/analyzer:{generatorDll}",
            $"/out:{outDir}",
            $"/manifest:{manifest}",
        };
        args.AddRange(RuntimeReferencePaths().Select(p => $"/r:{p}"));

        var stdout = new StringWriter();
        int exit = GsgenProgram.Run(args.ToArray(), stdout);

        Assert.Equal(0, exit);

        var generated = Directory.EnumerateFiles(outDir, "*.g.gs").ToList();
        var single = Assert.Single(generated);
        var content = File.ReadAllText(single);
        Assert.Contains("partial class Foo", content);
        Assert.Contains("Greeting", content);

        // The manifest lists exactly the generated file.
        var manifestLines = File.ReadAllLines(manifest).Where(l => l.Length > 0).ToList();
        var manifestEntry = Assert.Single(manifestLines);
        Assert.Equal(Path.GetFullPath(single), Path.GetFullPath(manifestEntry));
    }

    [Fact]
    public void OrphanCleanup_DeletesStalePartNotRegenerated()
    {
        string generatorDll = GeneratorDllFactory.Value;

        var outDir = Path.Combine(this.workDir, "gen");
        Directory.CreateDirectory(outDir);
        var stale = Path.Combine(outDir, "old.g.gs");
        File.WriteAllText(stale, "package App\n\npartial class Old {\n}\n");

        var gs = this.WriteGs("Foo.gs", "package App\n\n@Obsolete\npartial class Foo {\n}\n");

        var args = new List<string>
        {
            $"/gs:{gs}",
            $"/analyzer:{generatorDll}",
            $"/out:{outDir}",
        };
        args.AddRange(RuntimeReferencePaths().Select(p => $"/r:{p}"));

        var stdout = new StringWriter();
        int exit = GsgenProgram.Run(args.ToArray(), stdout);

        Assert.Equal(0, exit);
        Assert.False(File.Exists(stale), "Stale orphan .g.gs should have been deleted.");
        Assert.NotEmpty(Directory.EnumerateFiles(outDir, "*.g.gs"));
    }

    [Fact]
    public void MissingGsFile_ReturnsNonZero_EmitsGs9200_NoStackTrace()
    {
        string generatorDll = GeneratorDllFactory.Value;

        var outDir = Path.Combine(this.workDir, "gen");
        var missing = Path.Combine(this.workDir, "does-not-exist.gs");

        var stdout = new StringWriter();
        int exit = GsgenProgram.Run(
            new[] { $"/gs:{missing}", $"/analyzer:{generatorDll}", $"/out:{outDir}" },
            stdout);

        Assert.NotEqual(0, exit);
        var output = stdout.ToString();
        Assert.Contains("error GS9200", output);
        Assert.Matches(@"^gsgen\(1,1\): error GS9200:", output.Trim());
        Assert.DoesNotContain("   at ", output); // no stack-trace frames
    }

    [Fact]
    public void ForeignCsFile_NoAnalyzers_IsStillTranslated_AndFolded()
    {
        // Issue #2214: a stray .cs Compile item (standing in for Nerdbank.
        // GitVersioning's generated ThisAssembly.cs) must be translated even
        // when the project has NO generator packages at all — the common case
        // the ADR-0145 fast path already optimizes for generators.
        var outDir = Path.Combine(this.workDir, "gen");
        var manifest = Path.Combine(this.workDir, "manifest.txt");
        var gs = this.WriteGs("Foo.gs", "package App\n\nfunc Foo() {\n}\n");
        var cs = this.WriteCs(
            "ThisAssembly.cs",
            @"namespace App
{
    internal static class ThisAssembly
    {
        internal const string AssemblyFileVersion = ""1.2.3.4"";
    }
}
");

        var args = new List<string> { $"/gs:{gs}", $"/csfile:{cs}", $"/out:{outDir}", $"/manifest:{manifest}" };
        args.AddRange(RuntimeReferencePaths().Select(p => $"/r:{p}"));

        var stdout = new StringWriter();
        int exit = GsgenProgram.Run(args.ToArray(), stdout);

        Assert.Equal(0, exit);

        var generated = Directory.EnumerateFiles(outDir, "*.g.gs").ToList();
        var single = Assert.Single(generated);
        var content = File.ReadAllText(single);
        Assert.Contains("ThisAssembly", content);
        Assert.Contains("AssemblyFileVersion", content);
        Assert.Contains("1.2.3.4", content);

        var manifestLines = File.ReadAllLines(manifest).Where(l => l.Length > 0).ToList();
        var manifestEntry = Assert.Single(manifestLines);
        Assert.Equal(Path.GetFullPath(single), Path.GetFullPath(manifestEntry));
    }

    [Fact]
    public void NoAnalyzersNoCsFiles_FastPath_Unaffected()
    {
        // Guard: a project with no generators AND no stray .cs (the universal
        // common case) must still take the zero-cost fast path.
        var outDir = Path.Combine(this.workDir, "gen");
        var manifest = Path.Combine(this.workDir, "manifest.txt");
        var gs = this.WriteGs("Foo.gs", "package App\n\npartial class Foo {\n}\n");

        var stdout = new StringWriter();
        int exit = GsgenProgram.Run(
            new[] { $"/gs:{gs}", $"/out:{outDir}", $"/manifest:{manifest}" },
            stdout);

        Assert.Equal(0, exit);
        Assert.Equal(string.Empty, File.ReadAllText(manifest));
        Assert.False(Directory.Exists(outDir) && Directory.EnumerateFiles(outDir, "*.g.gs").Any());
    }

    private string WriteGs(string name, string source)
    {
        var path = Path.Combine(this.workDir, name);
        File.WriteAllText(path, source);
        return path;
    }

    private string WriteCs(string name, string source)
    {
        var path = Path.Combine(this.workDir, name);
        File.WriteAllText(path, source);
        return path;
    }

    private static IReadOnlyList<string> RuntimeReferencePaths()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty;
        return tpa
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
            .ToList();
    }

    /// <summary>
    /// Lazily compiles a real <see cref="Microsoft.CodeAnalysis.IIncrementalGenerator"/>
    /// to a DLL on disk (once per test run) so the CLI's <c>/analyzer:</c> load
    /// path is validated end to end. Mirrors the attribute-driven shape of
    /// <c>GeneratorHostEndToEndTests.GreetingGenerator</c>.
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

namespace GsgenTestGenerators
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
                assemblyName: "GsgenTestGenerators",
                syntaxTrees: new[] { tree },
                references: references,
                options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            var dllPath = Path.Combine(
                Path.GetTempPath(),
                "gsgen-cli-tests-gen",
                Guid.NewGuid().ToString("N") + ".dll");
            Directory.CreateDirectory(Path.GetDirectoryName(dllPath));

            using var fs = new FileStream(dllPath, FileMode.Create, FileAccess.Write);
            EmitResult emit = compilation.Emit(fs);
            if (!emit.Success)
            {
                var errors = string.Join(
                    "\n",
                    emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error));
                throw new InvalidOperationException("Failed to compile test generator DLL:\n" + errors);
            }

            return dllPath;
        }
    }
}
