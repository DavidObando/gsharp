// <copyright file="Issue3954AwaitableSemanticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3954: an awaitable means in G# what it means in C#, and the compiler
/// awaits for you only where the SYNTAX is a channel operation. Two halves,
/// which only work together (ADR-0174 errata 38).
/// </summary>
/// <remarks>
/// <para>Half one is D4's <c>await g()</c> row, which the ADR always stated
/// normatively and the implementation did not have: awaiting makes the
/// AWAITING function suspending. Before this, <c>await</c> outside an
/// <c>async func</c> was GS0132, so the only way colourless Go-style code could
/// reach a suspending callee was an implicit await.</para>
/// <para>Half two is that the four <c>ChannelBatchExtensions</c> methods drop
/// their hand-applied <c>[Suspending]</c>. That attribute is D4's cross-assembly
/// record for a G#-EMITTED function and keeps that job; applied by hand to a
/// C#-authored API it gave the API two contradictory shapes —
/// <c>ValueTask&lt;int&gt;</c> to C#, <c>int32</c> to G# — and
/// <c>X.AsTask()</c>, the idiom the C# tests use to start a batch, cancel it,
/// and await the count with a timeout, had no G# form at all.</para>
/// <para>Discrimination (ADR-0154): on the parent commit
/// <c>batch-call-is-a-nameable-task</c> and
/// <c>cancelled-mid-batch-through-the-task</c> fail with GS0159 "Cannot find
/// function AsTask" (the call's type was <c>int32</c>), and
/// <c>await-in-a-plain-func</c> and <c>batch-awaited-by-a-plain-func</c> fail
/// with GS0132. <c>await-at-a-boundary-is-rejected</c> is the control that
/// holds the new rule to D4's stated limits, and
/// <c>channel-syntax-still-awaits-implicitly</c> is the control that a mutant
/// removing the implicit await from channel OPERATIONS cannot pass — the
/// distinction this issue turns on is syntax versus library call.</para>
/// <para>Every executable case compiles, IL-verifies AND runs: the counts these
/// programs print are what distinguish a real transfer from a completed
/// placeholder, and a wrong state machine IL-verifies clean but deadlocks.</para>
/// </remarks>
public class Issue3954AwaitableSemanticsTests
{
    /// <summary>How long a compiled case may run before it counts as deadlocked.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // D4's `await g()` row: a plain `func` awaits an ordinary Task and is
        // coloured by the await, exactly as a channel operation would colour it.
        yield return new object[]
        {
            "await-in-a-plain-func",
            """
            package P
            import System

            async func answer() int32 {
                return 42
            }

            func ask() int32 {
                return await answer()
            }

            Console.WriteLine(ask())
            """,
            new[] { "42" },
        };

        // The batch surface after un-marking: colourless code still uses it,
        // now saying `await` where the compiler used to insert one.
        yield return new object[]
        {
            "batch-awaited-by-a-plain-func",
            """
            package P
            import System

            func drain(source chan[int32]) int32 {
                let buffer = []int32{0, 0, 0, 0}
                return await source.ReceiveBatch(Memory[int32](buffer), 1)
            }

            func run() int32 {
                var took = 0
                scope {
                    let ch = chan[int32](64)
                    ch <- 1
                    ch <- 2
                    ch <- 3
                    took = drain(ch)
                }

                return took
            }

            Console.WriteLine(run())
            """,
            new[] { "3" },
        };

        // The point of the issue: the call has a task the caller can NAME.
        // The second send only fits once the receive drains the buffer, so a
        // completed placeholder would not produce this total.
        yield return new object[]
        {
            "batch-call-is-a-nameable-task",
            """
            package P
            import System
            import System.Threading.Tasks

            async func run() int32 {
                let ch = chan[int32](2)
                let items = []int32{1, 2, 3, 4}
                let pending = ch.SendBatch(ReadOnlyMemory[int32](items)).AsTask()
                let buffer = []int32{0, 0, 0, 0}
                let took = await ch.ReceiveBatch(Memory[int32](buffer), 4)
                Console.WriteLine(await pending + took)
                return 0
            }

            await run()
            """,
            new[] { "8" },
        };

        // The migrated C# shape verbatim (ChannelBatchExtensionsTests
        // `ReceiveBatch_CancelledMidBatch_ReturnsTheCountSoFar`): start the
        // batch, cancel it, then await the count with a timeout. D10's
        // linearization rule says the count so far — 1 — not a throw.
        yield return new object[]
        {
            "cancelled-mid-batch-through-the-task",
            """
            package P
            import System
            import System.Threading
            import System.Threading.Channels
            import System.Threading.Tasks
            import Gsharp.Concurrency

            async func run() int32 {
                let ch = Channel.CreateBounded[int32](8)
                ch.Writer.TryWrite(1)
                let cts = CancellationTokenSource()
                let context = Context.FromToken(cts.Token)

                var buffer = [8]int32{}
                let pending = ch.Reader.ReceiveBatch(buffer, atLeast: 4, context).AsTask()
                cts.Cancel()
                Console.WriteLine(await pending.WaitAsync(TimeSpan.FromSeconds(30)))
                return 0
            }

            await run()
            """,
            new[] { "1" },
        };

        // Control: channel SYNTAX keeps its implicit await. This is the line
        // the issue draws, so a mutant that "fixes" #3954 by removing the
        // implicit await everywhere fails here — `<-ch` in a plain `func` needs
        // no `await`, and never will.
        yield return new object[]
        {
            "channel-syntax-still-awaits-implicitly",
            """
            package P
            import System

            func take(ch in chan[int32]) int32 {
                return <-ch
            }

            func run() int32 {
                var got = 0
                scope {
                    let ch = chan[int32](1)
                    ch <- 9
                    got = take(ch)
                }

                return got
            }

            Console.WriteLine(run())
            """,
            new[] { "9" },
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void AwaitableSemantics_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3954_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, name + ".dll");
            var (exitCode, diagnostics) = Compile(tempDir, source, outPath);
            Assert.True(exitCode == 0, $"gsc failed for '{name}':\n{diagnostics}");

            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Gets the rejection cases: each is (name, source, expected diagnostic id,
    /// an expected substring of the message).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // ADR-0174 D4 "where inference stops": an `await` cannot colour a
        // function whose signature inference may not change, so GS0574 asks
        // the author which coloring the fixed signature has. Without this the
        // new rule leaves an await in a body the emitter cannot state-machine.
        yield return new object[]
        {
            "await-at-a-boundary",
            """
            package P

            async func answer() int32 {
                return 42
            }

            open class Reader {
                open func read() int32 {
                    return await answer()
                }
            }
            """,
            "GS0574",
            "'read'",
        };

        // Errata 10: a `lock` body's monitor is thread-affine and reentrant,
        // which is why a channel operation there compiles to the BLOCKING form.
        // An explicit await has no blocking form to fall back to. Rejecting it
        // is what keeps the new rule from letting a continuation resume on
        // another thread and exit a monitor it does not hold.
        yield return new object[]
        {
            "await-inside-a-lock-body",
            """
            package P
            import System

            async func answer() int32 {
                return 42
            }

            func guarded(o Object, ch chan[int32]) int32 {
                var v = 0
                lock o {
                    v = await answer()
                }

                return v + <-ch
            }
            """,
            "GS0575",
            "thread-affine",
        };

        // The same rule holds where the body is ALREADY `async`: this shape
        // compiled before, and its hazard is the same one C# spells CS1996.
        yield return new object[]
        {
            "await-inside-a-lock-body-of-an-async-func",
            """
            package P
            import System

            async func answer() int32 {
                return 42
            }

            async func guarded(o Object) int32 {
                var v = 0
                lock o {
                    v = await answer()
                }

                return v
            }
            """,
            "GS0575",
            "CS1996",
        };

        // ADR-0174 D5: `BindGoStatement` strips the operand's own await, so one
        // still here is nested in its arguments — a shape no function kind can
        // lower. Before this rule it reached the emitter as GS9998, from an
        // `async func` too, so this case also closes a pre-existing hole.
        yield return new object[]
        {
            "await-nested-in-a-go-operand",
            """
            package P
            import System

            async func fetch() int32 {
                return 7
            }

            func consume(v int32) {
                Console.WriteLine(v)
            }

            func run() {
                scope {
                    go consume(await fetch())
                }
            }
            """,
            "GS0576",
            "Bind the awaited value to a local first",
        };

        yield return new object[]
        {
            "await-nested-in-a-go-operand-of-an-async-func",
            """
            package P
            import System

            async func fetch() int32 {
                return 7
            }

            func consume(v int32) {
                Console.WriteLine(v)
            }

            async func run() int32 {
                scope {
                    go consume(await fetch())
                }

                return 0
            }
            """,
            "GS0576",
            "Bind the awaited value to a local first",
        };
    }

    /// <summary>
    /// The positions an <c>await</c> may not occupy, now that it may occupy a
    /// plain <c>func</c>. Each must produce a diagnostic rather than reach the
    /// emitter, which is what the GS9998 these replace would have meant.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The expected diagnostic id.</param>
    /// <param name="expectedText">An expected substring of the message.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AwaitInAPositionItCannotOccupy_IsRejected(string name, string source, string expectedId, string expectedText)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3954_neg_").FullName;
        try
        {
            var (exitCode, diagnostics) = Compile(tempDir, source, Path.Combine(tempDir, name + ".dll"));

            Assert.True(exitCode != 0, $"'{name}' must not compile, but gsc succeeded.");
            Assert.Contains(expectedId, diagnostics, StringComparison.Ordinal);
            Assert.Contains(expectedText, diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (int ExitCode, string Diagnostics) Compile(string tempDir, string source, string outPath)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            var exitCode = Program.Main(args.ToArray());
            return (exitCode, compileOut.ToString() + compileErr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        // These programs discriminate by DEADLOCKING when the state machine is
        // wrong, so the reads must not be the thing that waits: draining
        // synchronously first would hang the whole run instead of failing this
        // case. Read asynchronously and bound the wait.
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s (deadlock).");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
