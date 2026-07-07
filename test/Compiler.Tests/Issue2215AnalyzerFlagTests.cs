// <copyright file="Issue2215AnalyzerFlagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Gsgen.Cli;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #2215: gsc's <c>/analyzer:&lt;path&gt;</c> flag spawns <c>gsgen</c> as a
/// sibling process (ADR-0027 — Roslyn never links into gsc itself) to run the
/// supplied generators before compiling, so any gsc caller — not just the SDK's
/// MSBuild target — gets generator output.
/// </summary>
public class Issue2215AnalyzerFlagTests
{
    // Resolved from the Gsgen.Cli ProjectReference, so it always points at the
    // gsgen.dll this same test run just built — no fragile path guessing.
    private static readonly string GsgenToolPath = typeof(GsgenProgram).Assembly.Location;

    [Fact]
    public void Analyzer_MissingValue_ReturnsError()
    {
        var sample = WriteTempGs("package P\n");
        using var err = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(err);
        try
        {
            var exit = Program.Main(new[] { sample, "/analyzer:" });
            Assert.NotEqual(0, exit);
            Assert.Contains("/analyzer requires a path", err.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
            File.Delete(sample);
        }
    }

    [Fact]
    public void Analyzer_GsgenToolNotFound_ReturnsErrorAndDoesNotCompile()
    {
        var sample = WriteTempGs("package P\n");
        using var err = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(err);
        try
        {
            var exit = Program.Main(new[]
            {
                sample,
                "/analyzer:/nonexistent/generator.dll",
                "/gsgentool:/nonexistent/gsgen.dll",
            });
            Assert.NotEqual(0, exit);
            Assert.Contains("gsgen was not found", err.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
            File.Delete(sample);
        }
    }

    [Fact]
    public void NoAnalyzer_DoesNotTouchGsgen_SameAsBaseline()
    {
        // Fast-path guard (requirement #3): omitting /analyzer entirely must
        // behave identically to today — a bogus /gsgentool: (which would fail
        // hard if gsgen were ever launched) must have zero effect.
        var sample = WriteTempGs("package P\n\nfunc Main() {\n}\n");
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var exit = Program.Main(new[] { sample, "/gsgentool:/nonexistent/gsgen.dll" });
            Assert.Equal(0, exit);
        }
        finally
        {
            Console.SetOut(prevOut);
            File.Delete(sample);
        }
    }

    [Fact]
    public void Analyzer_EndToEnd_GeneratorMemberReachesCompiledAssembly()
    {
        var tempDir = Directory.CreateTempSubdirectory("gsc_analyzer_e2e_").FullName;
        var sample = Path.Combine(tempDir, "Foo.gs");
        File.WriteAllText(sample, "package MyLib\n\n@Obsolete\npartial class Foo {\n}\n");
        var outPath = Path.Combine(tempDir, "MyLib.dll");

        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        int exit;
        try
        {
            exit = Program.Main(new[]
            {
                sample,
                "/analyzer:" + GeneratorDllFactory.Value,
                "/gsgentool:" + GsgenToolPath,
                "/target:library",
                "/out:" + outPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(exit == 0, $"gsc failed:\nstdout:\n{outWriter}\nstderr:\n{errWriter}");
        Assert.True(File.Exists(outPath));

        var assembly = Assembly.Load(File.ReadAllBytes(outPath));
        var foo = assembly.GetTypes().Single(t => t.Name == "Foo");

        // "Greeting" only exists on Foo if gsc actually ran the generator (via
        // gsgen) and folded its back-translated .g.gs into this compilation.
        Assert.NotNull(foo.GetProperty("Greeting"));

        try
        {
            Directory.Delete(tempDir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>
    /// Regression test for the PR #2221 rubber-duck review's blocking finding:
    /// gsc wrote unquoted paths into gsgen's <c>.gsgen.rsp</c>, so a source
    /// file, analyzer, or output directory under a path containing a space
    /// (e.g. Windows <c>C:\Users\John Smith\...</c>) got split into two bogus
    /// tokens by gsgen's <c>TokenizeResponseFileLine</c> whitespace splitter,
    /// failing with "unknown flag"/"file not found". This must fail before the
    /// rsp-quoting fix and pass after.
    /// </summary>
    [Fact]
    public void Analyzer_EndToEnd_PathsWithSpaces_GeneratorMemberReachesCompiledAssembly()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "gsc test " + Guid.NewGuid());
        Directory.CreateDirectory(tempDir);
        var sample = Path.Combine(tempDir, "Foo Bar.gs");
        File.WriteAllText(sample, "package MyLib\n\n@Obsolete\npartial class Foo {\n}\n");
        var outPath = Path.Combine(tempDir, "My Lib.dll");

        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        int exit;
        try
        {
            exit = Program.Main(new[]
            {
                sample,
                "/analyzer:" + GeneratorDllFactory.ValueWithSpace,
                "/gsgentool:" + GsgenToolPath,
                "/target:library",
                "/out:" + outPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(exit == 0, $"gsc failed:\nstdout:\n{outWriter}\nstderr:\n{errWriter}");
        Assert.True(File.Exists(outPath));

        var assembly = Assembly.Load(File.ReadAllBytes(outPath));
        var foo = assembly.GetTypes().Single(t => t.Name == "Foo");

        // Only present if gsgen actually ran (paths tokenized correctly) and
        // its output was folded back into this compilation.
        Assert.NotNull(foo.GetProperty("Greeting"));

        try
        {
            Directory.Delete(tempDir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private static string WriteTempGs(string source)
    {
        var path = Path.Combine(Path.GetTempPath(), $"gsc_analyzer_test_{Guid.NewGuid():N}.gs");
        File.WriteAllText(path, source);
        return path;
    }

    /// <summary>
    /// Lazily compiles a real <see cref="Microsoft.CodeAnalysis.IIncrementalGenerator"/>
    /// to a DLL on disk (once per test run), mirroring
    /// <c>GsgenCliTests.GeneratorDllFactory</c> in
    /// <c>GSharp.GeneratorHost.Tests</c> — an attribute-driven generator that
    /// adds a <c>Greeting</c> property to any type decorated with
    /// <c>[Obsolete]</c>.
    /// </summary>
    private static class GeneratorDllFactory
    {
        private static readonly Lazy<string> Lazy = new(() => Compile("gsc_analyzer_gen_"));

        // Same generator, compiled under a temp directory whose name contains
        // a space — reproduces issue #2221's rsp-quoting bug (gsgen's
        // tokenizer split gsc's unquoted /analyzer: path on the space).
        private static readonly Lazy<string> LazyWithSpace = new(() => Compile("gsc analyzer gen "));

        public static string Value => Lazy.Value;

        public static string ValueWithSpace => LazyWithSpace.Value;

        private static string Compile(string tempDirPrefix)
        {
            const string Source = @"
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
                ""System.ObsoleteAttribute"",
                predicate: static (node, _) => node is ClassDeclarationSyntax,
                transform: static (ctx, _) => (INamedTypeSymbol)ctx.TargetSymbol);

            context.RegisterSourceOutput(classes, static (spc, symbol) =>
            {
                // Must wrap in the target's own namespace (mirroring gsc's
                // /analyzer:-forwarded /r: package) — an un-namespaced partial
                // is a DIFFERENT (global-namespace) type from `MyLib.Foo`, so
                // back-translation would emit it as a separate, colliding G#
                // declaration (GS0102) instead of a real partial part.
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
                "GscAnalyzerFlagTestGenerators",
                new[] { tree },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            var dir = Directory.CreateTempSubdirectory(tempDirPrefix).FullName;
            var path = Path.Combine(dir, "GscAnalyzerFlagTestGenerators.dll");

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

        private static IReadOnlyList<string> RuntimeReferencePaths()
        {
            var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty;
            return tpa
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
                .ToList();
        }
    }
}
