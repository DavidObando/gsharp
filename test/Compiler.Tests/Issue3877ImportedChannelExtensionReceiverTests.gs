// <copyright file="Issue3877ImportedChannelExtensionReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3877: a C#-authored generic extension on `ChannelReader<T>`
/// or `ChannelWriter<T>` was invisible on the `chan[T]` spelling
/// every caller actually writes.
/// @remarks The report blamed the RECEIVER slot of
/// `TryBindImportedExtensionCall`, on the evidence that the same extension
/// works once the receiver is already an `in chan[T]`. Measured on
/// `9c422bd8` that diagnosis does not hold, and the correction is recorded
/// on the issue. The dividing line is GENERIC versus NON-GENERIC, not receiver
/// versus argument:
///
/// - a NON-generic `this ChannelReader<int>` extension binds on a `chan[int32]` receiver and emits
/// `get_Reader` correctly — the receiver slot has classified the view conversion since #2611, and #3981
/// taught the lattice to classify it between two imported spellings;
/// - a GENERIC one fails in ARGUMENT position too (`StaticProbes.CountOf(ch)`), which the report's
/// "only the receiver slot fails" reading does not predict. The report's own control passed because
/// `viaReader(ch)` is a G#-declared function whose argument goes through `Conversion`, never through
/// CLR inference.
/// - a generic extension whose `T` is reachable from a USER ARGUMENT bound fine on a `chan[T]` receiver
/// (`ch.SendAll(3, 4)`) — which pins the gap exactly: the receiver's contribution to inference, and
/// nothing else.
///
/// The cause is method type-argument INFERENCE.
/// `ClrOverloadResolution.UnifyForInference` matched a closed generic
/// formal against the argument's own class hierarchy and interfaces. The
/// channel direction lattice (ADR-0174 D2) is the one implicit conversion G#
/// admits between two DISTINCT closed generic CLR types — no base class or
/// interface links `Channel<T>` to `ChannelReader<T>` —
/// so `T` received no bound at all, inference failed, and the candidate
/// never reached the applicability pass that would have accepted it.
///
/// The fix contributes the element as a bound and stays deliberately
/// direction-blind, because `Conversion` owns the lattice and applicability
/// enforces it. (cref:RejectedCases) is what holds that split honest: a
/// writer extension is still member-not-found on an `in chan[T]`, a reader
/// extension on an `out chan[T]`, and the element still has to match.
///
/// Consequence, and the sharpest evidence the fix is real: ADR-0174
/// errata 32's workaround is gone. `ChannelBatchExtensions` declared eight
/// methods where D10 specifies four — each directional method had a
/// `Channel<T>` twin whose only purpose was to keep
/// `ch.ReceiveBatch(…)` from being member-not-found. The four twins are
/// deleted in the same commit and the D10 suites still pass, which means they
/// now exercise the directional methods through this very conversion.
open class Issue3877ImportedChannelExtensionReceiverTests {
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func AnImportedChannelExtension_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3877_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`consumer compile failed for '` + "$name" + `':
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
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

    /// Permissive inference must not become a permissive lattice: each of these
    /// stays member-not-found, and none of them reaches the emitter (GS9998).
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    func TheLattice_StillDecidesApplicability(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3877_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as deadlocked.
        private const RunTimeout int32 = 60_000

        /// The C# library every case links against. Compiled with nullable
        /// annotations ENABLED on purpose: an oblivious signature imports a
        /// `Channel<int>` as `Channel[int32]?`, and a nullable
        /// source does not convert to a non-nullable channel — ordinary G#
        /// nullability, unrelated to this issue.
        private const LibrarySource string = (`using System;
using System.Threading.Channels;

namespace Interop;

public static class ReaderExtensions
{
    // The issue's own extension, verbatim.
    public static int CountSoFar<T>(this ChannelReader<T> reader) => reader.Count;

    // Moves a value THROUGH the receiver, so a wrong view is observably
    // wrong rather than merely IL-clean.
    public static T TakeFirst<T>(this ChannelReader<T> reader)
        => reader.TryRead(out var item)
            ? item
            : throw new InvalidOperationException("nothing buffered");

    // The non-generic control: this one always bound.
    public static int TakeInt(this ChannelReader<int> reader)
        => reader.TryRead(out var item) ? item : -1;

    // A reader extension over a DIFFERENT element, for the invariance case.
    public static int TakeTextLength(this ChannelReader<string> reader)
        => reader.TryRead(out var item) ? item.Length : -1;
}

public static class WriterExtensions
{
    // ` + "`" + `T` + "`" + ` is inferable from the ARGUMENTS here, so this one always
    // bound — the receiver never had to contribute a bound.
    public static int SendAll<T>(this ChannelWriter<T> writer, T first, T second)
        => (writer.TryWrite(first) ? 1 : 0) + (writer.TryWrite(second) ? 1 : 0);

    // ` + "`" + `T` + "`" + ` is inferable ONLY from the receiver: the value arrives boxed.
    public static int SendBoxed<T>(this ChannelWriter<T> writer, object value)
        => writer.TryWrite((T)value) ? 1 : 0;
}

public static class StaticProbes
{
    // Not an extension at all: the same conversion in plain ARGUMENT
    // position, which the issue's diagnosis says already worked.
    public static int CountOf<T>(ChannelReader<T> reader) => reader.Count;
}

public static class UnrelatedExtensions
{
    public static int Unrelated(this string text) => text.Length;
}`)

        /// Gets the cases that must compile, IL-verify and run: each is (name, G#
        /// source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The issue's exact repro, plus a value pulled through the receiver so
            // the reader view is the one actually emitted.
            yield[]object{"a-generic-reader-extension-binds-on-a-chan-receiver", `package P
import System
import Interop

func run() int32 {
    var got = 0
    scope {
        let ch = chan[int32](4)
        ch <- 7
        ch <- 8
        got = ch.CountSoFar() * 100 + ch.TakeFirst()
    }

    return got
}

Console.WriteLine(run())`, []string{"207"}}
            // The writer twin, with `T` reachable ONLY through the receiver (the
            // value arrives boxed as `object`). The element is read back out
            // through G#'s own receive, so a wrong view cannot fake the result.
            yield[]object{"a-generic-writer-extension-binds-on-a-chan-receiver", `package P
import System
import Interop

func run() int32 {
    var got = 0
    scope {
        let ch = chan[int32](4)
        let sent = ch.SendBoxed(41)
        let received = <-ch
        got = sent * 100 + received
    }

    return got
}

Console.WriteLine(run())`, []string{"141"}}
            // Control, green on both sides, and the precise shape of the gap: the
            // SAME writer extension bound before the fix whenever `T` was reachable
            // from a user argument. Only the receiver's own contribution to
            // inference was missing.
            yield[]object{"control-a-generic-writer-extension-whose-T-comes-from-an-argument", `package P
import System
import Interop

func run() int32 {
    var got = 0
    scope {
        let ch = chan[int32](4)
        let sent = ch.SendAll(3, 4)
        let first = <-ch
        let second = <-ch
        got = sent * 100 + first * 10 + second
    }

    return got
}

Console.WriteLine(run())`, []string{"234"}}
            // The finding that corrects the issue: a generic imported method fails
            // in ARGUMENT position too, so this row is red before the fix as well.
            yield[]object{"a-generic-static-infers-through-the-view-in-argument-position", `package P
import System
import Interop

func run() int32 {
    var got = 0
    scope {
        let ch = chan[int32](4)
        ch <- 1
        ch <- 2
        got = StaticProbes.CountOf(ch)
    }

    return got
}

Console.WriteLine(run())`, []string{"2"}}
            // The issue's control 1, green on both sides: the same imported
            // extension reached through a receiver that is already `in chan[T]`.
            yield[]object{"control-the-same-extension-on-an-in-chan-receiver", `package P
import System
import Interop

func viaReader(r in chan[int32]) int32 {
    return r.CountSoFar() * 100 + r.TakeFirst()
}

func run() int32 {
    var got = 0
    scope {
        let ch = chan[int32](4)
        ch <- 7
        ch <- 8
        got = viaReader(ch)
    }

    return got
}

Console.WriteLine(run())`, []string{"207"}}
            // Control, green on both sides, and the one that refutes the issue's
            // diagnosis: a NON-generic imported extension on `ChannelReader<int>`
            // already bound on a `chan[int32]` receiver and already emitted
            // `get_Reader`. Whatever was broken, it was not the receiver slot's
            // ability to classify the view.
            yield[]object{"control-a-non-generic-reader-extension-already-bound", `package P
import System
import Interop

func run() int32 {
    var got = 0
    scope {
        let ch = chan[int32](4)
        ch <- 7
        got = ch.TakeInt()
    }

    return got
}

Console.WriteLine(run())`, []string{"7"}}
            // The issue's control 2, green on both sides: G#'s own extension lookup
            // has always applied the view in receiver position.
            yield[]object{"control-a-gsharp-declared-extension-on-a-chan-receiver", `package P
import System

func (r in chan[int32]) firstOrZero() int32 {
    let (v, ok) = <-r
    return v
}

func run() int32 {
    var got = 0
    scope {
        let ch = chan[int32](1)
        ch <- 7
        got = ch.firstOrZero()
    }

    return got
}

Console.WriteLine(run())`, []string{"7"}}
        }

        /// Gets the calls that must stay rejected: each is (name, G# source, a
        /// substring the diagnostics must name). Every row is red before and after
        /// — inference became permissive on purpose, and these prove the lattice
        /// still decides applicability.
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // A send-only handle must not acquire a reader's surface.
            yield[]object{"a-reader-extension-is-invisible-on-a-send-only-receiver", `package P
import System
import Interop

func viaWriter(w out chan[int32]) int32 {
    return w.CountSoFar()
}

Console.WriteLine(viaWriter(chan[int32](1)))`, "CountSoFar"}
            // …and the twin, which is the row the fix could most plausibly have
            // broken: inference now infers `T` for a `ChannelWriter<T>` formal from
            // a `ChannelReader<int>` argument, and applicability has to reject it.
            yield[]object{"a-writer-extension-is-invisible-on-a-receive-only-receiver", `package P
import System
import Interop

func viaReader(r in chan[int32]) int32 {
    return r.SendAll(1, 2)
}

Console.WriteLine(viaReader(chan[int32](1)))`, "SendAll"}
            // `Channel<T>` is invariant; the element check runs whatever the
            // direction lattice says.
            yield[]object{"the-element-still-has-to-match", `package P
import System
import Interop

let ch = chan[int32](1)
Console.WriteLine(ch.TakeTextLength())`, "TakeTextLength"}
            // An extension with nothing to do with channels stays member-not-found:
            // the fix widened inference through channel SHAPES, not through
            // everything the receiver could be coerced into.
            yield[]object{"an-unrelated-extension-stays-member-not-found", `package P
import System
import Interop

let ch = chan[int32](1)
Console.WriteLine(ch.Unrelated())`, "Unrelated"}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Interop",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "Interop.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
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
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            // A wrong channel view fails by DEADLOCKING rather than erroring, so
            // read asynchronously and bound the wait — otherwise the read is what
            // hangs and takes the whole run with it.
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
