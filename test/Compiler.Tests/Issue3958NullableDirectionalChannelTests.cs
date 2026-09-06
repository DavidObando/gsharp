// <copyright file="Issue3958NullableDirectionalChannelTests.cs" company="GSharp">
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
/// Issue #3958: a conversion whose target was a NULLABLE directional channel —
/// <c>in chan[T]?</c> or <c>out chan[T]?</c> — bound and then failed in the
/// emitter with GS9998 "not yet supported".
/// </summary>
/// <remarks>
/// <para>It was neither the directional head on its own (<c>out chan[T]</c>
/// worked) nor the nullable wrapper on its own (<c>chan[T]?</c> worked) — the
/// two together. <c>Conversion.TryClassifyChannelConversion</c> deliberately
/// declines a nullable operand and leaves the pair to the lifted rules, which
/// classify it fine; it was <c>EmitConversion</c>'s channel arm that matched
/// the target being a channel DIRECTLY, so a <c>NullableTypeSymbol</c> wrapper
/// missed it, the <c>get_Reader</c>/<c>get_Writer</c> view was never emitted,
/// and the conversion fell through to the unsupported-conversion throw. Every
/// channel shape is a class, so the wrapper is a binder-level annotation over
/// an identical CLR representation, and the arm now looks through it the same
/// way the delegate arms below it do.</para>
/// <para>Why the shape matters: ADR-0159's own GS0520 tells the author to
/// declare a channel-typed slot <c>out chan[int32]?</c> when the channel is
/// genuinely optional — advice that produced a slot nothing could be assigned
/// into. <see cref="Cases"/>'s field case is that advice taken.</para>
/// <para>Discrimination (ADR-0154): the four executable cases fail on the
/// parent commit with GS9998 naming the exact conversion. The two controls are
/// green on both sides and hold the fix to its claim — a nil directional
/// channel must still disable a <c>select</c> arm rather than throw
/// (<c>TryGetChannelShape</c> looks through the wrapper on the SOURCE side, and
/// that is what makes a blocked-forever arm work), and a nullable channel must
/// still NOT convert to a non-nullable one, since looking through a wrapper for
/// the view call must not become looking past nil safety.</para>
/// <para>Every executable case compiles, IL-verifies AND runs, and each moves a
/// value through the converted handle: binding alone cannot tell whether the
/// right view was emitted, and a wrong one IL-verifies clean.</para>
/// </remarks>
public class Issue3958NullableDirectionalChannelTests
{
    /// <summary>How long a compiled case may run before it counts as deadlocked.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The issue's own repro, made to move a value: an `out chan[T]?` local
        // initialised from what `chan[T](n)` constructs.
        yield return new object[]
        {
            "out-nullable-from-a-constructed-channel",
            """
            package P
            import System

            func run() int32 {
                var got = 0
                scope {
                    let ch = chan[int32](1)
                    var w out chan[int32]? = ch
                    w!! <- 4
                    got = <-ch
                }

                return got
            }

            Console.WriteLine(run())
            """,
            new[] { "4" },
        };

        yield return new object[]
        {
            "in-nullable-from-a-constructed-channel",
            """
            package P
            import System

            func run() int32 {
                var got = 0
                scope {
                    let ch = chan[int32](1)
                    var r in chan[int32]? = ch
                    ch <- 5
                    got = <-r!!
                }

                return got
            }

            Console.WriteLine(run())
            """,
            new[] { "5" },
        };

        // GS0520's advice taken: an optional channel slot on a struct, plus the
        // parameter and return-type positions, which reach the same conversion.
        yield return new object[]
        {
            "nullable-directional-field-parameter-and-return",
            """
            package P
            import System

            struct Holder {
                var sink out chan[int32]?
                var source in chan[int32]?
            }

            func take(w out chan[int32]?, r in chan[int32]?) int32 {
                w!! <- 3
                return <-r!!
            }

            func make() out chan[int32]? {
                return chan[int32](1)
            }

            func run() int32 {
                var total = 0
                scope {
                    let ch = chan[int32](4)
                    var h = Holder{}
                    h.sink = ch
                    h.source = ch
                    total = total + take(ch, ch)

                    let m = make()
                    m!! <- 7

                    h.sink!! <- 10
                    total = total + <-h.source!!
                }

                return total
            }

            Console.WriteLine(run())
            """,
            new[] { "13" },
        };

        // A nullable bidirectional handle narrowing to each nullable view: the
        // source's own wrapper is looked through by `TryGetChannelShape`, the
        // target's by the emitter arm, so both sides are exercised at once.
        yield return new object[]
        {
            "nullable-bidirectional-to-nullable-directional",
            """
            package P
            import System

            func run() int32 {
                var got = 0
                scope {
                    var bi chan[int32]? = chan[int32](1)
                    var w out chan[int32]? = bi
                    var r in chan[int32]? = bi
                    w!! <- 6
                    got = <-r!!
                }

                return got
            }

            Console.WriteLine(run())
            """,
            new[] { "6" },
        };

        // Control, green before and after: a nil directional channel disables
        // its `select` arm rather than throwing (ADR-0174 D2/D8). Looking
        // through the wrapper for the view call must not disturb the nil
        // channel's blocked-forever semantics, which is what makes a disabled
        // arm work at all.
        yield return new object[]
        {
            "a-nil-directional-arm-stays-disabled",
            """
            package P
            import System

            func run() int32 {
                var got = 0
                scope {
                    var w out chan[int32]? = nil
                    let ch = chan[int32](1)
                    ch <- 5
                    select {
                    case let v = <-ch {
                        got = v
                    }
                    case w <- 9 {
                        got = -1
                    }
                    }
                }

                return got
            }

            Console.WriteLine(run())
            """,
            new[] { "5" },
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
    public void NullableDirectionalChannel_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3958_").FullName;
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
    /// Control, green before and after: looking through the nullable wrapper to
    /// emit the view must not become looking past nil safety. A <c>chan[T]?</c>
    /// still does not convert to a non-nullable <c>out chan[T]</c>.
    /// </summary>
    [Fact]
    public void ANullableChannel_StillDoesNotConvertToANonNullableOne()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3958_neg_").FullName;
        try
        {
            var (exitCode, diagnostics) = Compile(
                tempDir,
                """
                package P

                var bi chan[int32]? = chan[int32](1)
                var w out chan[int32] = bi
                """,
                Path.Combine(tempDir, "nullability.dll"));

            Assert.True(exitCode != 0, "a nullable channel must not convert to a non-nullable one.");
            Assert.Contains("GS0156", diagnostics, StringComparison.Ordinal);
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

        // A wrong view emits a handle that never completes its counterpart, so
        // these programs fail by DEADLOCKING. Read asynchronously and bound the
        // wait, or the read is what hangs and takes the whole run with it.
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
