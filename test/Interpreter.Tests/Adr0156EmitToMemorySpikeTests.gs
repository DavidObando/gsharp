// <copyright file="Adr0156EmitToMemorySpikeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.Loader
import Xunit
import Xunit.Abstractions

/// ADR-0156 feasibility spike, kept as a self-contained pin of the
/// emit-to-memory execution mechanic: compile with the real emitter into a
/// (cref:MemoryStream), load the PE bytes into a collectible
/// (cref:AssemblyLoadContext), invoke the entry point in-process,
/// capture stdout and the exit code, and prove the ALC is reclaimed after
/// unload. The tree-walking-evaluator comparison arm retired with the
/// evaluator in Phase 3c (#3176); the golden-file assertions remain.
/// @remarks This is spike evidence for docs/adr/0156-gsi-emit-to-memory-execution.md,
/// not part of the conformance gate. Keep it cheap: three representative
/// samples.
@Trait("Category", "Adr0156Spike")
class Adr0156EmitToMemorySpikeTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("Arithmetic.gs")
    @InlineData("ArrowLambda.gs")
    @InlineData("AsyncTask.gs")
    func EmitToMemory_RunInCollectibleAlc_MatchesGolden(sampleName string) {
        let samplesDirectory = LocateSamplesDirectory()
        let sourcePath = Path.Combine(samplesDirectory, sampleName)
        let golden = Normalize(File.ReadAllText(Path.ChangeExtension(sourcePath, ".golden")))
        // --- Emit-to-memory driver ------------------------------------------
        let parseAndBind = Stopwatch.StartNew()
        let tree = SyntaxTree.Load(sourcePath)
        let emitCompilation = Compilation(tree)
        let _ = emitCompilation.GlobalScope // force bind so emit timing is emit-only
        parseAndBind.Stop()
        using let peStream = MemoryStream()
        let emitTimer = Stopwatch.StartNew()
        let emitResult = emitCompilation.Emit(peStream)
        emitTimer.Stop()
        Assert.True(emitResult.Success, string.Join("\n", emitResult.Diagnostics))
        Assert.True(peStream.Length > int64(0), "Emit produced an empty PE stream.")
        let runTimer = Stopwatch.StartNew()
        let (emittedStdout, emittedExitCode, alcWeakRef) = LoadAndRun(peStream)
        runTimer.Stop()
        Assert.Equal(golden, emittedStdout)
        Assert.Equal(0, emittedExitCode)
        // --- Collectibility: the ALC must be reclaimable after unload --------
        for var i = 0; alcWeakRef.IsAlive && i < 10; i++ {
            GC.Collect()
            GC.WaitForPendingFinalizers()
        }
        Assert.False(alcWeakRef.IsAlive, "Collectible AssemblyLoadContext was not reclaimed after unload.")
        this.output.WriteLine(
            "$sampleName: parse+bind ${parseAndBind.ElapsedMilliseconds} ms, " +
                "emit-to-memory ${emitTimer.ElapsedMilliseconds} ms (${peStream.Length} bytes), " +
                "ALC load+run ${runTimer.ElapsedMilliseconds} ms"
        )
    }

    /// Measures the steady-state per-submission cost the interactive REPL
    /// pays under emit-to-memory: repeated emit+load+run of a small
    /// submission, after warm-up.
    @Fact
    func EmitToMemory_SteadyStateSubmissionLatency() {
        const source = `package Spike.Latency
import System
var x = 21
Console.WriteLine(x * 2)
`
        const iterations = 5
        // Warm-up once (JIT of the emitter itself).
        RunEmitOnce(source)
        let emitTimer = Stopwatch.StartNew()
        for var i = 0; i < iterations; i++ {
            Assert.Equal("42${Environment.NewLine}", RunEmitOnce(source))
        }
        emitTimer.Stop()
        this.output.WriteLine(
            "steady-state per submission: emit+load+run ${float64(emitTimer.ElapsedMilliseconds) / float64(iterations):F1} ms ($iterations iterations)"
        )
    }

    shared {
        private func RunEmitOnce(source string) string {
            let compilation = Compilation(SyntaxTree.Parse(source))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            let (stdout, exitCode, _) = LoadAndRun(peStream)
            Assert.Equal(0, exitCode)
            return stdout
        }

        // Isolated in a non-inlinable method so no JIT-rooted locals keep the
        // AssemblyLoadContext alive when the caller checks collectibility.
        @MethodImpl(MethodImplOptions.NoInlining)
        private func LoadAndRun(peStream MemoryStream)(Stdout string, ExitCode int32, AlcWeakRef WeakReference) {
            let alc = AssemblyLoadContext("gsi-spike-${Guid.NewGuid():N}", isCollectible: true)
            let weakRef = WeakReference(alc)
            // Framework and reference assemblies resolve through the default
            // context; only the emitted program itself lives in the collectible ALC.
            alc.Resolving += (_ AssemblyLoadContext, assemblyName AssemblyName) -> {
                try {
                    return Assembly.Load(assemblyName)
                } catch (FileNotFoundException) {
                    return nil
                }
            }
            try {
                peStream.Position = 0
                let assembly = alc.LoadFromStream(peStream)
                let entryPoint MethodInfo? = assembly.EntryPoint
                Assert.NotNull(entryPoint)
                let previousOut = Console.Out
                using let writer = StringWriter{NewLine: Environment.NewLine}
                Console.SetOut(writer)
                var returnValue object?
                try {
                    let arguments[]?object = if entryPoint!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                    returnValue = entryPoint!!.Invoke(nil, arguments)
                } finally {
                    Console.SetOut(previousOut)
                }
                let exitCode = switch returnValue {
                    case rc is int32: rc
                    case rc is uint32: unchecked(int32(rc))
                    default: 0
                }
                return (Normalize(writer.ToString()), exitCode, weakRef)
            } finally {
                alc.Unload()
            }
        }

        private func Normalize(text string) string -> text.ReplaceLineEndings(Environment.NewLine)

        private func LocateSamplesDirectory() string {
            for var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory);
                directory != nil;
                directory = directory!!
                .Parent {
                let candidate = Path.Combine(directory.FullName, "samples")
                if File.Exists(Path.Combine(candidate, "Arithmetic.gs")) {
                    return candidate
                }
            }
            throw InvalidOperationException("Could not locate the samples directory.")
        }
    }
}
