// <copyright file="Issue3958NullableDirectionalChannelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3958: a conversion whose target was a NULLABLE directional channel —
/// `in chan[T]?` or `out chan[T]?` — bound and then failed in the
/// emitter with GS9998 "not yet supported".
/// @remarks It was neither the directional head on its own (`out chan[T]`
/// worked) nor the nullable wrapper on its own (`chan[T]?` worked) — the
/// two together. `Conversion.TryClassifyChannelConversion` deliberately
/// declines a nullable operand and leaves the pair to the lifted rules, which
/// classify it fine; it was `EmitConversion`'s channel arm that matched
/// the target being a channel DIRECTLY, so a `NullableTypeSymbol` wrapper
/// missed it, the `get_Reader`/`get_Writer` view was never emitted,
/// and the conversion fell through to the unsupported-conversion throw. Every
/// channel shape is a class, so the wrapper is a binder-level annotation over
/// an identical CLR representation, and the arm now looks through it the same
/// way the delegate arms below it do.
///
/// Why the shape matters: ADR-0159's own GS0520 tells the author to
/// declare a channel-typed slot `out chan[int32]?` when the channel is
/// genuinely optional — advice that produced a slot nothing could be assigned
/// into. (cref:Cases)'s field case is that advice taken.
///
/// Discrimination (ADR-0154): the four executable cases fail on the
/// parent commit with GS9998 naming the exact conversion. The two controls are
/// green on both sides and hold the fix to its claim — a nil directional
/// channel must still disable a `select` arm rather than throw
/// (`TryGetChannelShape` looks through the wrapper on the SOURCE side, and
/// that is what makes a blocked-forever arm work), and a nullable channel must
/// still NOT convert to a non-nullable one, since looking through a wrapper for
/// the view call must not become looking past nil safety.
///
/// Every executable case compiles, IL-verifies AND runs, and each moves a
/// value through the converted handle: binding alone cannot tell whether the
/// right view was emitted, and a wrong one IL-verifies clean.
open class Issue3958NullableDirectionalChannelTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func NullableDirectionalChannel_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3958_").FullName
        try {
            let outPath = Path.Combine(tempDir, name + ".dll")
            let (exitCode, diagnostics) = Compile(tempDir, source, outPath)
            Assert.True(exitCode == 0, (`gsc failed for '` + "$name" + `':
` + "$diagnostics"))
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Control, green before and after: looking through the nullable wrapper to
    /// emit the view must not become looking past nil safety. A `chan[T]?`
    /// still does not convert to a non-nullable `out chan[T]`.
    @Fact
    func ANullableChannel_StillDoesNotConvertToANonNullableOne() {
        let tempDir = Directory.CreateTempSubdirectory("gs_3958_neg_").FullName
        try {
            let (exitCode, diagnostics) = Compile(tempDir, `package P

var bi chan[int32]? = chan[int32](1)
var w out chan[int32] = bi`, Path.Combine(tempDir, "nullability.dll"))
            Assert.True(exitCode != 0, "a nullable channel must not convert to a non-nullable one.")
            Assert.Contains("GS0156", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as deadlocked.
        private const RunTimeout int32 = 60_000

        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The issue's own repro, made to move a value: an `out chan[T]?` local
            // initialised from what `chan[T](n)` constructs.
            yield[]object{"out-nullable-from-a-constructed-channel", `package P
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

Console.WriteLine(run())`, []string{"4"}}
            yield[]object{"in-nullable-from-a-constructed-channel", `package P
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

Console.WriteLine(run())`, []string{"5"}}
            // GS0520's advice taken: an optional channel slot on a struct, plus the
            // parameter and return-type positions, which reach the same conversion.
            yield[]object{"nullable-directional-field-parameter-and-return", `package P
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

Console.WriteLine(run())`, []string{"13"}}
            // A nullable bidirectional handle narrowing to each nullable view: the
            // source's own wrapper is looked through by `TryGetChannelShape`, the
            // target's by the emitter arm, so both sides are exercised at once.
            yield[]object{"nullable-bidirectional-to-nullable-directional", `package P
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

Console.WriteLine(run())`, []string{"6"}}
            // Control, green before and after: a nil directional channel disables
            // its `select` arm rather than throwing (ADR-0174 D2/D8). Looking
            // through the wrapper for the view call must not disturb the nil
            // channel's blocked-forever semantics, which is what makes a disabled
            // arm work at all.
            yield[]object{"a-nil-directional-arm-stays-disabled", `package P
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

Console.WriteLine(run())`, []string{"5"}}
        }

        private func Compile(tempDir string, source string, outPath string)(ExitCode int32, Diagnostics string) {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                let exitCode = Program.Main(args.ToArray())
                return (exitCode, compileOut.ToString() + compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            // A wrong view emits a handle that never completes its counterpart, so
            // these programs fail by DEADLOCKING. Read asynchronously and bound the
            // wait, or the read is what hangs and takes the whole run with it.
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s (deadlock).")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
