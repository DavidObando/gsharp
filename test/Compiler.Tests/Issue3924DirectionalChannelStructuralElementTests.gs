// <copyright file="Issue3924DirectionalChannelStructuralElementTests.cs" company="GSharp">
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

/// Issue #3924: a channel whose element is a STRUCTURAL G# type — `[]int32`,
/// `map[string,int32]`, `[][]int32` — did not convert to the
/// `in`/`out` directional view (ADR-0174 D2), while the identical
/// conversion over a named element (`int32`, `string`, a
/// same-compilation `struct`) bound fine.
/// @remarks Root cause: the direction lattice compares the two sides' element
/// types by SYMBOL shape. A channel recovered from CLR metadata — both the
/// constructed `Gsharp.Concurrency.Chan<T>` that `chan[T](n)`
/// builds and a foreign BCL `Channel<T>` — carries whatever
/// `TypeSymbol.FromClrType` mints for the reflected type argument, and a
/// structural shape has no CLR counterpart symbol: `[]int32` comes back as
/// an `ImportedTypeSymbol` over `int32[]`, never the
/// `SliceTypeSymbol` the `chan[T]` type clause bound. The elements
/// denote ONE runtime type, so the CLR-type comparison the fix adds is the
/// question `Channel<T>`'s invariance actually asks.
///
/// Discrimination (ADR-0154): every executable case below failed with
/// GS0154 at bind on the pre-fix build (measured on `ffa46214`) EXCEPT
/// `struct-slice-element`, which travels the symbolic-type-argument branch
/// and passed before and after — it is the control that keeps a blanket
/// "any channel converts to any channel" mutant from passing. The negative
/// facts pin the other edge: a mismatched element (`[]int64` for
/// `[]int32`), a nullable element (`int32?` for `int32` — the
/// case that forces the EFFECTIVE CLR type, since a
/// `NullableTypeSymbol` borrows its underlying type's `ClrType`), and
/// `in` → `out` must all still be rejected. Three more are green
/// before and after, and pin the fallback's "one side came back from
/// reflection carrying no symbolic type arguments" guard: a fixed-array length
/// mismatch between two type clauses, and two shapes over a source-constructed
/// generic element, whose `ClrType` has erased the very arguments that
/// distinguish it (`List[Foo]` and `List[Bar]` over two
/// same-compilation structs are one `List<object>`).
///
/// Every case compiles, IL-verifies AND runs: binding alone cannot tell
/// whether `get_Reader`/`get_Writer` was really emitted for a
/// structural element, which is the half of the fix that reaches metadata.
open class Issue3924DirectionalChannelStructuralElementTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func DirectionalChannel_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3924_").FullName
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

    /// A channel whose element is merely CLR-compatible, not the same type,
    /// still fails to convert: the fix compares the element's effective CLR
    /// type, it does not wave every channel through.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMessage The expected diagnostic substring.
    @Theory
    @MemberData("RejectedCases")
    func MismatchedChannel_IsStillRejected(name string, source string, expectedMessage string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3924_neg_").FullName
        try {
            let outPath = Path.Combine(tempDir, name + ".dll")
            let (exitCode, diagnostics) = Compile(tempDir, source, outPath)
            Assert.True(exitCode != 0, "'$name' must not compile, but gsc succeeded.")
            Assert.Contains("GS0154", diagnostics, StringComparison.Ordinal)
            Assert.Contains(expectedMessage, diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            yield[]object{"slice-element-out-and-in", `package P
import System

func produce(w out chan[[]int32]) {
    w <- [3]int32{1, 2, 3}
    w <- [2]int32{4, 5}
    w.Close()
}

func consume(r in chan[[]int32]) int32 {
    var sum = 0
    for batch in r {
        var i = 0
        while i < batch.Length {
            sum = sum + batch[i]
            i = i + 1
        }
    }

    return sum
}

let ch = chan[[]int32](4)
produce(ch)
Console.WriteLine(consume(ch))`, []string{"15"}}
            yield[]object{"map-element-out-and-in", `package P
import System

func produce(w out chan[map[string,int32]]) {
    var m = map[string,int32]{}
    m["a"] = 2
    m["b"] = 3
    w <- m
    w.Close()
}

func consume(r in chan[map[string,int32]]) int32 {
    var total = 0
    for entry in r {
        total = total + entry["a"] + entry["b"]
    }

    return total
}

let ch = chan[map[string,int32]](2)
produce(ch)
Console.WriteLine(consume(ch))`, []string{"5"}}
            yield[]object{"nested-slice-element", `package P
import System

func produce(w out chan[[][]int32]) {
    var outer = [2][]int32{}
    outer[0] = [2]int32{1, 2}
    outer[1] = [1]int32{4}
    w <- outer
    w.Close()
}

func consume(r in chan[[][]int32]) int32 {
    var sum = 0
    for rows in r {
        var i = 0
        while i < rows.Length {
            var j = 0
            while j < rows[i].Length {
                sum = sum + rows[i][j]
                j = j + 1
            }

            i = i + 1
        }
    }

    return sum
}

let ch = chan[[][]int32](2)
produce(ch)
Console.WriteLine(consume(ch))`, []string{"7"}}
            yield[]object{"slice-of-string-element", `package P
import System

func produce(w out chan[[]string]) {
    w <- [2]string{"a", "b"}
    w.Close()
}

let ch = chan[[]string](2)
produce(ch)
for parts in ch {
    Console.WriteLine(parts[0] + parts[1])
}`, []string{"ab"}}
            // Control: a same-compilation struct element has no reference-context
            // CLR type, so `chan[[]Point](2)` closes over a symbolic type argument
            // and `TryGetChannelShape` reads the ORIGINAL element symbol back out
            // of `TypeArguments[0]`. This bound before the fix and must keep
            // binding after it.
            yield[]object{"struct-slice-element", `package P
import System

struct Point {
    var X int32
}

func produce(w out chan[[]Point]) {
    var arr = [1]Point{}
    arr[0].X = 9
    w <- arr
    w.Close()
}

let ch = chan[[]Point](2)
produce(ch)
for points in ch {
    Console.WriteLine(points[0].X)
}`, []string{"9"}}
            // A foreign BCL channel is the case the fix must cover that no amount
            // of preserving G# element symbols at CONSTRUCTION could: this
            // `Channel<int32[]>` was never built by `chan[T](n)`, so its element
            // exists only as reflected CLR metadata.
            yield[]object{"foreign-bcl-channel-with-slice-element", `package P
import System
import System.Threading.Channels

func produce(w out chan[[]int32]) {
    w <- [2]int32{10, 20}
    w.Close()
}

func consume(r in chan[[]int32]) int32 {
    var sum = 0
    for batch in r {
        var i = 0
        while i < batch.Length {
            sum = sum + batch[i]
            i = i + 1
        }
    }

    return sum
}

let ch = Channel.CreateBounded[[]int32](2)
produce(ch)
Console.WriteLine(consume(ch))`, []string{"30"}}
        }

        /// Gets the rejection cases: each is (name, source, the expected substring
        /// of the reported diagnostic).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            yield[]object{"mismatched-slice-element", `package P

func wants(w out chan[[]int32]) {
}

let wrong = chan[[]int64](1)
wants(wrong)`, "requires a value of type 'out chan[[]int32]'"}
            yield[]object{"nullable-element-is-not-the-bare-element", `package P

func wants(w out chan[int32?]) {
}

let plain = chan[int32](1)
wants(plain)`, "requires a value of type 'out chan[int32?]'"}
            // A no-regression pin, green before and after: where BOTH sides still
            // carry their G# symbols, the fixed length discriminates, and the
            // CLR-type fallback must not reach them — `[3]int32` and `[4]int32`
            // are one `int32[]`. A mutant that drops the fallback's
            // "one side came back from metadata" guard compiles this.
            yield[]object{"fixed-array-lengths-still-discriminate", `package P

func wants(w out chan[[4]int32]) {
}

var a chan[[3]int32] = chan[[3]int32](1)
wants(a)`, "requires a value of type 'out chan[[4]int32]'"}
            // A source-constructed generic still holds its type arguments as
            // SYMBOLS, and its own `ClrType` may have erased them to close over
            // `object`: `List[Foo]` and `List[Bar]` over two same-compilation
            // structs are one `List<object>`. Comparing that would conflate two
            // elements that are not the same type at all — ordinary assignment
            // rejects `List[Bar]` to `List[Foo]` with GS0155 — so the fallback
            // must not reach a source-constructed element. A mutant that widens
            // the guard from "no symbolic type arguments" to "any imported
            // symbol" compiles both of these.
            yield[]object{"source-constructed-generic-elements-are-not-conflated", `package P
import System.Collections.Generic

struct Foo {
    var X int32
}

struct Bar {
    var Y int32
}

func wants(w out chan[List[Foo]]) {
}

var barChan chan[List[Bar]] = chan[List[Bar]](1)
wants(barChan)`, "requires a value of type 'out chan[System.Collections.Generic.List[Foo]]'"}
            yield[]object{"fixed-array-length-inside-a-constructed-generic-element", `package P
import System.Collections.Generic

struct Foo {
    var X int32
}

func wants(w out chan[List[[4]Foo]]) {
}

var nested chan[List[[3]Foo]] = chan[List[[3]Foo]](1)
wants(nested)`, "requires a value of type 'out chan[System.Collections.Generic.List[[4]Foo]]'"}
            yield[]object{"receive-only-does-not-satisfy-send-only", `package P

func wants(w out chan[[]int32]) {
}

func pass(r in chan[[]int32]) {
    wants(r)
}`, "requires a value of type 'out chan[[]int32]'"}
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
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
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
