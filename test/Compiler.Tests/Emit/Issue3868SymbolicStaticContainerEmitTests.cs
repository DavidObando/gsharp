// <copyright file="Issue3868SymbolicStaticContainerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using GSharp.Compiler.Tests.Fixtures;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3868 — a static call on an imported generic type closed over a
/// SAME-COMPILATION user type (<c>Verifier[MyType].M(...)</c>) is parented at
/// the constructed <c>Verifier&lt;MyType&gt;</c> TypeSpec by the #1330 symbolic
/// path. That path declined <c>params</c>-expanded and defaulted-parameter call
/// shapes and fell through to the ordinary resolution, which emitted the
/// type-erased <c>Verifier&lt;object&gt;</c> parent (ADR-0004 / #313: a
/// same-compilation type has no CLR <c>Type</c> during binding, so it rides
/// through imported-member resolution as <c>object</c>).
/// <para>
/// The result compiled clean, failed ilverify with
/// <c>UnsatisfiedMethodParentInst</c> (11 of the 19 findings in the migrated
/// <c>test/Core.Tests</c>, issue #3863) and threw
/// <c>TypeLoadException: GenericArguments[0], 'System.Object' … violates the
/// constraint of type parameter</c> the first time the call ran. Every test
/// here EXECUTES the emitted program, because ilverify accepts a wrong parent
/// instantiation whenever the constraint happens to be satisfiable.
/// </para>
/// </summary>
public class Issue3868SymbolicStaticContainerEmitTests
{
    private static readonly string FixtureAssemblyPath = typeof(Issue3868Base).Assembly.Location;

    /// <summary>
    /// The regression: the <c>params</c> and defaulted shapes must reach the
    /// real <c>Issue3868Verifier&lt;MyAnalyzer&gt;</c>. Before the fix this
    /// aborted with <c>TypeLoadException</c> on the first variadic call.
    /// </summary>
    [Fact]
    public void EndToEnd_ParamsAndDefaultedStaticCalls_UseTheRealTypeArgument()
    {
        var source = """
            package N3868A
            import System
            import GSharp.Compiler.Tests.Fixtures

            class MyAnalyzer3868 : Issue3868Base {
                override func Name() string {
                    return "mine"
                }
            }

            func Main() {
                Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Variadic("s"))
                Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Variadic("s", "A"))
                Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Variadic("s", "A", "B"))
                Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Defaulted("s"))
            }
            """;

        var output = CompileAndRun(source);

        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "variadic:mine:s:0",
                "variadic:mine:s:1",
                "variadic:mine:s:2",
                "defaulted:mine:s:d") + Environment.NewLine,
            output);
    }

    /// <summary>
    /// Anti-vacuity guard: the fixed-arity and fully-supplied shapes were
    /// ALREADY correct on <c>origin/main</c> (they take the #1330 symbolic
    /// path). They must stay correct — a fix that changed how the symbolic
    /// container is chosen would show up here.
    /// </summary>
    [Fact]
    public void EndToEnd_FixedAndFullySuppliedStaticCalls_StayCorrect()
    {
        var source = """
            package N3868B
            import System
            import GSharp.Compiler.Tests.Fixtures

            class MyAnalyzer3868B : Issue3868Base {
                override func Name() string {
                    return "mineB"
                }
            }

            func Main() {
                Console.WriteLine(Issue3868Verifier[MyAnalyzer3868B].Fixed("s"))
                Console.WriteLine(Issue3868Verifier[MyAnalyzer3868B].Defaulted("s", "t"))
            }
            """;

        var output = CompileAndRun(source);

        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "fixed:mineB:s",
                "defaulted:mineB:s:t") + Environment.NewLine,
            output);
    }

    /// <summary>
    /// Compiles <paramref name="source"/> against the host reference closure
    /// plus this test assembly (which hosts the fixture), emits into the test
    /// output directory so the fixture assembly resolves by ordinary app-dir
    /// probing, ILVerifies, then RUNS the program and returns its stdout.
    /// </summary>
    /// <param name="source">G# source to compile.</param>
    /// <returns>The program's stdout.</returns>
    private static string CompileAndRun(string source)
    {
        var outputDir = Path.GetDirectoryName(FixtureAssemblyPath)
            ?? throw new InvalidOperationException("fixture assembly has no directory");
        var stem = "gs3868_" + Guid.NewGuid().ToString("N");
        var srcPath = Path.Combine(Path.GetTempPath(), stem + ".gs");
        var dllPath = Path.Combine(outputDir, stem + ".dll");
        var rtConfig = Path.Combine(outputDir, stem + ".runtimeconfig.json");

        try
        {
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var reference in ReferenceAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath, new[] { FixtureAssemblyPath });

            File.WriteAllText(rtConfig, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = outputDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(60_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            foreach (var path in new[] { srcPath, dllPath, rtConfig, Path.ChangeExtension(dllPath, ".pdb") })
            {
                try
                {
                    File.Delete(path);
                }
                catch (IOException)
                {
                    // Best-effort cleanup; a locked artifact must not fail the test.
                }
                catch (UnauthorizedAccessException)
                {
                    // Best-effort cleanup.
                }
            }
        }
    }

    private static IEnumerable<string> ReferenceAssemblies()
        => ReferenceClosure.TrustedPlatformAssemblies()
            .Append(FixtureAssemblyPath)
            .Distinct(StringComparer.Ordinal);
}
