// <copyright file="Adr0156EmitToMemorySpikeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 feasibility spike: prove that the emit-to-memory execution model —
/// compile with the real emitter into a <see cref="MemoryStream"/>, load the PE
/// bytes into a collectible <see cref="AssemblyLoadContext"/>, invoke the entry
/// point in-process, capture stdout and the exit code — produces the same
/// observable result as the tree-walking evaluator and the sample's golden
/// file, without touching the filesystem and without spawning a process.
/// </summary>
/// <remarks>
/// This is spike evidence for docs/adr/0156-gsi-emit-to-memory-execution.md,
/// not part of the conformance gate. It intentionally exercises only the
/// Phase 1 mechanic (whole-program scripts); interactive submission chaining
/// is Phase 2 design work. Keep it cheap: three representative samples.
/// </remarks>
[Trait("Category", "Adr0156Spike")]
public sealed class Adr0156EmitToMemorySpikeTests
{
    private readonly ITestOutputHelper output;

    public Adr0156EmitToMemorySpikeTests(ITestOutputHelper output) => this.output = output;

    [Theory]
    [InlineData("Arithmetic.gs")]      // locals, functions, loops, top-level entry point
    [InlineData("ArrowLambda.gs")]     // closures / lambda emission
    [InlineData("AsyncTask.gs")]       // async state-machine lowering
    public void EmitToMemory_RunInCollectibleAlc_MatchesEvaluatorAndGolden(string sampleName)
    {
        var samplesDirectory = LocateSamplesDirectory();
        var sourcePath = Path.Combine(samplesDirectory, sampleName);
        var golden = Normalize(File.ReadAllText(Path.ChangeExtension(sourcePath, ".golden")));

        // --- Emit-to-memory driver ------------------------------------------
        var parseAndBind = Stopwatch.StartNew();
        var tree = SyntaxTree.Load(sourcePath);
        var emitCompilation = new Compilation(tree);
        _ = emitCompilation.GlobalScope; // force bind so emit timing is emit-only
        parseAndBind.Stop();

        using var peStream = new MemoryStream();
        var emitTimer = Stopwatch.StartNew();
        var emitResult = emitCompilation.Emit(peStream);
        emitTimer.Stop();
        Assert.True(emitResult.Success, string.Join("\n", emitResult.Diagnostics));
        Assert.True(peStream.Length > 0, "Emit produced an empty PE stream.");

        var runTimer = Stopwatch.StartNew();
        var (emittedStdout, emittedExitCode, alcWeakRef) = LoadAndRun(peStream);
        runTimer.Stop();

        // --- Tree-walking evaluator driver (current gsi engine) -------------
        var evalTimer = Stopwatch.StartNew();
        var (evalStdout, evalValue) = Evaluate(sourcePath);
        evalTimer.Stop();

        // --- Parity ----------------------------------------------------------
        Assert.Equal(golden, emittedStdout);
        Assert.Equal(0, emittedExitCode);
        Assert.Equal(golden, evalStdout);

        // --- Collectibility: the ALC must be reclaimable after unload --------
        for (var i = 0; alcWeakRef.IsAlive && i < 10; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }

        Assert.False(alcWeakRef.IsAlive, "Collectible AssemblyLoadContext was not reclaimed after unload.");

        this.output.WriteLine(
            $"{sampleName}: parse+bind {parseAndBind.ElapsedMilliseconds} ms, " +
            $"emit-to-memory {emitTimer.ElapsedMilliseconds} ms ({peStream.Length} bytes), " +
            $"ALC load+run {runTimer.ElapsedMilliseconds} ms, " +
            $"evaluator run {evalTimer.ElapsedMilliseconds} ms, " +
            $"eval value [{evalValue ?? "nil"}]");
    }

    /// <summary>
    /// Measures the steady-state per-submission cost the interactive REPL would
    /// pay under emit-to-memory: repeated emit+load+run of a small submission,
    /// after warm-up, versus repeated evaluator runs of the same program.
    /// </summary>
    [Fact]
    public void EmitToMemory_SteadyStateSubmissionLatency()
    {
        const string source = "package Spike.Latency\nimport System\nvar x = 21\nConsole.WriteLine(x * 2)\n";
        const int iterations = 5;

        // Warm-up both paths once (JIT of the emitter/evaluator themselves).
        RunEmitOnce(source);
        RunEvalOnce(source);

        var emitTimer = Stopwatch.StartNew();
        for (var i = 0; i < iterations; i++)
        {
            Assert.Equal("42\n", RunEmitOnce(source));
        }

        emitTimer.Stop();

        var evalTimer = Stopwatch.StartNew();
        for (var i = 0; i < iterations; i++)
        {
            Assert.Equal("42\n", RunEvalOnce(source));
        }

        evalTimer.Stop();

        this.output.WriteLine(
            $"steady-state per submission: emit+load+run {emitTimer.ElapsedMilliseconds / (double)iterations:F1} ms, " +
            $"evaluator {evalTimer.ElapsedMilliseconds / (double)iterations:F1} ms ({iterations} iterations)");
    }

    private static string RunEmitOnce(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        var (stdout, exitCode, _) = LoadAndRun(peStream);
        Assert.Equal(0, exitCode);
        return stdout;
    }

    private static string RunEvalOnce(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        var previousOut = Console.Out;
        using var writer = new StringWriter { NewLine = "\n" };
        Console.SetOut(writer);
        try
        {
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return Normalize(writer.ToString());
    }

    private static (string Stdout, string Value) Evaluate(string sourcePath)
    {
        var compilation = new Compilation(SyntaxTree.Load(sourcePath));
        var previousOut = Console.Out;
        using var writer = new StringWriter { NewLine = "\n" };
        Console.SetOut(writer);
        object value;
        try
        {
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
            value = result.Value;
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return (Normalize(writer.ToString()), value?.ToString());
    }

    // Isolated in a non-inlinable method so no JIT-rooted locals keep the
    // AssemblyLoadContext alive when the caller checks collectibility.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (string Stdout, int ExitCode, WeakReference AlcWeakRef) LoadAndRun(MemoryStream peStream)
    {
        var alc = new AssemblyLoadContext($"gsi-spike-{Guid.NewGuid():N}", isCollectible: true);
        var weakRef = new WeakReference(alc);

        // Framework and reference assemblies resolve through the default
        // context; only the emitted program itself lives in the collectible ALC.
        alc.Resolving += (_, assemblyName) =>
        {
            try
            {
                return Assembly.Load(assemblyName);
            }
            catch (FileNotFoundException)
            {
                return null;
            }
        };

        try
        {
            peStream.Position = 0;
            var assembly = alc.LoadFromStream(peStream);
            var entryPoint = assembly.EntryPoint;
            Assert.NotNull(entryPoint);

            var previousOut = Console.Out;
            using var writer = new StringWriter { NewLine = "\n" };
            Console.SetOut(writer);
            object returnValue;
            try
            {
                var arguments = entryPoint.GetParameters().Length == 0
                    ? null
                    : new object[] { Array.Empty<string>() };
                returnValue = entryPoint.Invoke(null, arguments);
            }
            finally
            {
                Console.SetOut(previousOut);
            }

            var exitCode = returnValue switch
            {
                int rc => rc,
                uint rc => unchecked((int)rc),
                _ => 0,
            };

            return (Normalize(writer.ToString()), exitCode, weakRef);
        }
        finally
        {
            alc.Unload();
        }
    }

    private static string Normalize(string text) => text.Replace("\r\n", "\n", StringComparison.Ordinal);

    private static string LocateSamplesDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "samples");
            if (File.Exists(Path.Combine(candidate, "Arithmetic.gs")))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("Could not locate the samples directory.");
    }
}
