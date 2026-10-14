// <copyright file="Issue4020AwaitForOverAnOpenAsyncSequenceTests.cs" company="GSharp">
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

/// Issue #4020: `await for v in s` over an `async sequence[T]` whose
/// element has no CLR backing reported `GS0134` ("cannot be iterated with
/// 'await for'"), while the CLOSED `async sequence[int32]` spelling of the
/// same parameter iterated and the SYNCHRONOUS `for v in s` over an
/// equally open `sequence[T]` iterated too.
/// @remarks <b>Root cause, two layers.</b>
/// `MemberLookup.TryGetAsyncEnumerableElementType` — the binder's gate for
/// the `await for` operand — recognised the shape only through
/// `ClrType`, and `AsyncSequenceTypeSymbol.MakeClrType` answers null
/// the moment the element is an in-scope type parameter or a same-compilation
/// class. That is the #3982 / #3987 / #4011 family exactly: a shape known by
/// its `ClrType` when closed and by nothing at all when open. Teaching the
/// gate to answer from the symbol moved the failure one phase down, to
/// `Lowerer.LowerAwaitForRange`, whose first line reads the stream's
/// `ClrType` and returns an unreported error node when it is null —
/// GS9998. Both layers are fixed: the lowerer now surfaces the type-ERASED
/// `IAsyncEnumerable<object>` to drive reflection while carrying the
/// element symbolically, which is the same #1002 shape its existing arms
/// already handle and the async twin of what
/// `TryBuildSymbolicOpenGetEnumeratorCall` does for the synchronous
/// loop.
///
/// <b>The `ClrType == null` trap, caught in review.</b> The first draft
/// of the lowering fix gated on `streamClr == null`. That is precisely the
/// mistake #4023's own correction warns about one file over: an
/// `async sequence[T]` over an IMPORTED element
/// (`async sequence[DateTime]`, `async sequence[List[int32]]`,
/// `async sequence[StringBuilder]`) has a NON-null `ClrType` —
/// closing the host `IAsyncEnumerable<>` over a
/// `MetadataLoadContext` argument answers a
/// `TypeBuilderInstantiation` — so the gate skipped it and
/// `GetMethod("GetAsyncEnumerator")` threw. Worse, the binder arm had by
/// then turned what used to be a GS0134 diagnostic into a GS9998 internal
/// error, so those shapes REGRESSED. Every `AsyncSequenceTypeSymbol` now
/// takes the symbolic path, exactly as every `SequenceTypeSymbol` already
/// does in `TryBuildSymbolicOpenGetEnumeratorCall` — whose own comment
/// gives this same reason, and which is why the synchronous
/// `for v in sequence[DateTime]` never had either half of this bug.
///
/// <b>The misleading diagnostic, fixed alongside.</b> The issue notes
/// that both `SequenceTypeSymbol` and `AsyncSequenceTypeSymbol`
/// displayed as `sequence[T]`, so GS0134's own text could not say which
/// symbol the binder held — and it sent the issue's first reader to the wrong
/// one. `SymbolDisplay` now prints the async form as
/// `async sequence[T]`, the spelling the author writes for it (ADR-0041).
/// (cref:TheTwoSequenceSymbols_NoLongerDisplayIdentically) pins both
/// halves: the async form names itself, and the sync form — which
/// `await for` must still refuse — still reads `sequence[T]`.
///
/// <b>Not a channel change.</b> `async sequence` is
/// channel-ADJACENT, but nothing here touches a `chan[T]`, a select arm,
/// or a direction, and ADR-0174's D-series contract is unchanged — so no
/// erratum.
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Binding/MemberLookup.cs`,
/// `src/Core/CodeAnalysis/Lowering/Lowerer.cs` and
/// `src/Core/CodeAnalysis/Symbols/Display/SymbolDisplay.cs` to
/// `565b9a04` turns every (cref:AcceptedCases) row red with GS0134
/// and fails the display test, and leaves every (cref:ControlCases) and
/// (cref:RejectedCases) row exactly as it is.
open class Issue4020AwaitForOverAnOpenAsyncSequenceTests {
    /// An open `async sequence[T]` iterates, and the program compiles,
    /// IL-verifies, runs, and prints what it claims.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func AnOpenAsyncSequence_IteratesWithAwaitFor(name string, source string, expectedLines[]string) {
        RunCase("gs_4020_", name, source, expectedLines)
    }

    /// The rows that already worked keep working.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("ControlCases")
    func AShapeThatAlreadyIterated_StillIterates(name string, source string, expectedLines[]string) {
        RunCase("gs_4020_control_", name, source, expectedLines)
    }

    /// `await for` still refuses what is not an async enumerable.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the compile must report.
    /// @param expectedMention A substring of the diagnostic's text.
    @Theory
    @MemberData("RejectedCases")
    func AnOperandThatIsNotAnAsyncEnumerable_IsStillRefused(
        name string,
        source string,
        expectedId string,
        expectedMention string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4020_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The second half of the issue: the two sequence symbols used to print
    /// the same text, so a diagnostic could not say which one the binder had.
    /// The async form now names itself; the synchronous form is unchanged.
    @Fact
    func TheTwoSequenceSymbols_NoLongerDisplayIdentically() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4020_display_").FullName
        try {
            const AsyncSource = `package P
import System

async func numbers() async sequence[int32] {
    yield 1
}

func takesInt(x int32) int32 { return x }

func main2() {
    Console.WriteLine(takesInt(numbers()).ToString())
}

main2()`
            const SyncSource = `package P
import System

func numbers() sequence[int32] {
    yield 1
}

func takesInt(x int32) int32 { return x }

func main2() {
    Console.WriteLine(takesInt(numbers()).ToString())
}

main2()`
            let asyncLog = Compile(tempDir, "Async.gs", AsyncSource, Path.Combine(tempDir, "async.dll"), "/target:exe")
            Assert.Contains("'async sequence[int32]'", asyncLog, StringComparison.Ordinal)
            let syncLog = Compile(tempDir, "Sync.gs", SyncSource, Path.Combine(tempDir, "sync.dll"), "/target:exe")
            Assert.Contains("'sequence[int32]'", syncLog, StringComparison.Ordinal)
            Assert.DoesNotContain("'async sequence[int32]'", syncLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// Every row reports `GS0134` on `565b9a04`. Each moves the
        /// loop's values into the printed answer, so a loop that binds but
        /// iterates the wrong thing prints the wrong answer.
        /// @returns Name, G# source, expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // The issue's own repro, with the closed spelling beside the open one
            // so a disagreement between them is visible in the output.
            yield[]object{"an-open-async-sequence-parameter-iterates-like-the-closed-one", `package P
import System

async func numbers() async sequence[int32] {
    yield 1
    yield 2
    yield 3
}

async func closed(s async sequence[int32]) int32 {
    var n = 0
    await for v in s {
        n = n + v
    }

    return n
}

async func openElement[T](s async sequence[T]) string {
    var acc = ""
    await for v in s {
        acc = acc + v.ToString()
    }

    return acc
}

async func run() {
    Console.WriteLine((await closed(numbers())).ToString())
    Console.WriteLine(await openElement[int32](numbers()))
}

run().Wait()`, []string{"6", "123"}}
            // A same-compilation class element: the OTHER way an async sequence
            // loses its ClrType, and the one that proves the loop variable keeps
            // the member-bearing symbol rather than the erased `object`.
            yield[]object{"an-async-sequence-over-a-same-compilation-class-reads-its-members", `package P
import System

class Item {
    var Tag string
}

async func items() async sequence[Item] {
    var a = Item{}
    a.Tag = "one"
    yield a
    var b = Item{}
    b.Tag = "two"
    yield b
}

async func tags(s async sequence[Item]) string {
    var acc = ""
    await for v in s {
        acc = acc + v.Tag + ";"
    }

    return acc
}

async func run() {
    Console.WriteLine(await tags(items()))
}

run().Wait()`, []string{"one;two;"}}
            // `break` and `continue` inside the loop (issue #937's labels) must
            // resolve against the newly-reachable lowering too.
            yield[]object{"break-and-continue-inside-an-open-async-sequence-loop", `package P
import System

async func numbers() async sequence[int32] {
    yield 1
    yield 2
    yield 3
    yield 4
}

async func pick[T](s async sequence[T]) string {
    var acc = ""
    await for v in s {
        if v.ToString() == "2" {
            continue
        }

        if v.ToString() == "4" {
            break
        }

        acc = acc + v.ToString()
    }

    return acc
}

async func run() {
    Console.WriteLine(await pick[int32](numbers()))
}

run().Wait()`, []string{"13"}}
            // Review feedback on #4034 (Copilot), measured and confirmed. The
            // first draft of the lowering fix gated on `streamClr == null`, which
            // is the very trap #4023's own correction describes: an
            // `async sequence[T]` over an IMPORTED element has a NON-null
            // `ClrType` that is a `TypeBuilderInstantiation`, so the gate skipped
            // it, `GetMethod("GetAsyncEnumerator")` threw
            // `NotSupportedException`, and the loop still reported GS9998 — a
            // REGRESSION, since the binder arm had by then turned what used to be
            // a GS0134 diagnostic into an internal compiler error. Every
            // `AsyncSequenceTypeSymbol` now takes the symbolic path, as every
            // `SequenceTypeSymbol` already did. These three rows are what proves
            // it: an imported STRUCT element (whose `Current` must not arrive
            // boxed), an imported CLASS element, and a constructed imported
            // GENERIC element — each reading a member off the loop variable so an
            // `object`-typed element would not compile.
            yield[]object{"an-async-sequence-over-an-imported-struct-element", `package P
import System

async func stamps() async sequence[DateTime] {
    yield DateTime.UnixEpoch
    yield DateTime.UnixEpoch
}

async func years(s async sequence[DateTime]) int32 {
    var n = 0
    await for v in s {
        n = n + v.Year
    }

    return n
}

async func run() {
    Console.WriteLine((await years(stamps())).ToString())
}

run().Wait()`, []string{"3940"}}
            yield[]object{"an-async-sequence-over-a-constructed-imported-generic-element", `package P
import System
import System.Collections.Generic

async func bags() async sequence[List[int32]] {
    yield List[int32]()
    yield List[int32]()
}

async func total(s async sequence[List[int32]]) int32 {
    var n = 0
    await for v in s {
        n = n + v.Count + 1
    }

    return n
}

async func run() {
    Console.WriteLine((await total(bags())).ToString())
}

run().Wait()`, []string{"2"}}
            yield[]object{"an-async-sequence-over-an-imported-class-element", `package P
import System
import System.Text

async func builders() async sequence[StringBuilder] {
    var b = StringBuilder()
    b.Append("abc")
    yield b
}

async func lengths(s async sequence[StringBuilder]) int32 {
    var n = 0
    await for v in s {
        n = n + v.Length
    }

    return n
}

async func run() {
    Console.WriteLine((await lengths(builders())).ToString())
}

run().Wait()`, []string{"3"}}
        }

        /// Rows already GREEN on `565b9a04` that must stay green: the closed
        /// spelling, the `IAsyncEnumerable[T]` workaround the issue names, and
        /// the synchronous sibling the issue measured as unaffected.
        /// @returns Name, G# source, expected stdout lines.
        func ControlCases() sequence[[]object] {
            yield[]object{"control-the-open-iasyncenumerable-workaround-and-the-sync-sibling", `package P
import System
import System.Collections.Generic

func syncNumbers() sequence[int32] {
    yield 7
    yield 8
}

async func numbers() async sequence[int32] {
    yield 1
    yield 2
    yield 3
}

async func countAsync[T](s IAsyncEnumerable[T]) int32 {
    var n = 0
    await for v in s {
        n = n + 1
    }

    return n
}

func sumSync[T](s sequence[T]) string {
    var acc = ""
    for v in s {
        acc = acc + v.ToString()
    }

    return acc
}

async func run() {
    Console.WriteLine((await countAsync[int32](numbers())).ToString())
    Console.WriteLine(sumSync[int32](syncNumbers()))
}

run().Wait()`, []string{"3", "78"}}
            // The issue's "otherwise well-formed" rows: an open async sequence
            // still passes as an argument to both spellings of the parameter.
            yield[]object{"control-an-async-sequence-still-crosses-both-parameter-spellings", `package P
import System
import System.Collections.Generic

async func numbers() async sequence[int32] {
    yield 1
}

func takesOpenAsync[T](s async sequence[T]) int32 { return 1 }

func takesOpenIAsync[T](s IAsyncEnumerable[T]) int32 { return 3 }

func main2() {
    Console.WriteLine(takesOpenAsync[int32](numbers()).ToString())
    Console.WriteLine(takesOpenIAsync[int32](numbers()).ToString())
}

main2()`, []string{"1", "3"}}
        }

        /// What `await for` must still refuse, so recognising the async
        /// sequence symbol did not make the operand check accept anything that is
        /// not an async enumerable — a synchronous `sequence[T]` above all.
        /// @returns Name, G# source, the diagnostic id and a substring of its text.
        func RejectedCases() sequence[[]object] {
            yield[]object{"await-for-over-a-non-enumerable-is-still-refused", `package P
import System

async func run() {
    await for v in 5 {
        Console.WriteLine(v.ToString())
    }
}

run().Wait()`, "GS0134", "'int32'"}
            yield[]object{"await-for-over-a-synchronous-open-sequence-is-still-refused", `package P
import System

func numbers() sequence[int32] {
    yield 1
}

async func bad[T](s sequence[T]) int32 {
    var n = 0
    await for v in s {
        n = n + 1
    }

    return n
}

async func run() {
    Console.WriteLine((await bad[int32](numbers())).ToString())
}

run().Wait()`, "GS0134", "'sequence[T]'"}
        }

        private func RunCase(prefix string, name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory(prefix).FullName
            try {
                let appPath = Path.Combine(tempDir, name + ".dll")
                let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
                Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile:
` + "$appLog"))
                IlVerifier.Verify(appPath)
                let (exit, output) = RunDotnet(appPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
                Assert.Equal(expectedLines, SplitLines(output))
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

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
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
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
