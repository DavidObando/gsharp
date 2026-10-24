// <copyright file="Issue5171RefAliasNarrowingTests.cs" company="GSharp">
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

/// Issue #5171 (ADR-0208 row R12): a `ref` local and the variable it aliases
/// name one storage, and a by-reference parameter or a `ref` local of an element
/// or member names storage that no root names. Before the correction, a narrowing
/// fact on the alias survived a write to the aliased variable, a write through a
/// sibling alias, an index or member write, and a call, so the program compiled and
/// threw `NullReferenceException`.
///
/// Every rejected case goes through the compiler driver and asserts the exit
/// code, the diagnostic and its location. Every accepted case compiles,
/// IL-verifies, runs and asserts the output.
open class Issue5171RefAliasNarrowingTests {
    /// A write that can change the aliased storage makes the later read through
    /// the alias report the nullable-receiver diagnostic.
    /// @param name The case name.
    /// @param source The G# program.
    @Theory
    @MemberData("RejectedCases")
    func WriteToTheStorage_InvalidatesAliasNarrowing_ReportsNullableReceiver(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5171_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let (exit, log) = Compile(tempDir, source, appPath)
            Assert.NotEqual(0, exit)
            Assert.False(File.Exists(appPath), "'$name' must not emit an assembly. Log:\n$log")
            Assert.Contains(
                ExpectedDiagnostic(Path.Combine(tempDir, name + ".gs"), source),
                log,
                StringComparison.Ordinal
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Narrowing that no write can invalidate, or that the program re-proves,
    /// stays valid.
    /// @param name The case name.
    /// @param source The G# program.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("AcceptedCases")
    func UnrelatedWrite_KeepsAliasNarrowing_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5171_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let (exit, log) = Compile(tempDir, source, appPath)
            Assert.True(exit == 0, "'$name' must compile. Log:\n$log")
            IlVerifier.Verify(appPath)
            let (runExit, output) = RunDotnet(appPath)
            Assert.True(runExit == 0, "'$name' must run to completion. Exit $runExit:\n$output")
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

    shared {
        /// Builds the driver line prefix of the `GS0158` that the unique `.Value` read of
        /// [`source`](paramref) must report: file, 1-based line and column of `Value`, and its end.
        private func ExpectedDiagnostic(path string, source string) string {
            let dot = source.IndexOf(".Value", StringComparison.Ordinal)
            Assert.True(dot >= 0, "the case must read `.Value` once")
            Assert.True(
                source.IndexOf(".Value", dot + 1, StringComparison.Ordinal) < 0,
                "the case must read `.Value` once"
            )
            var line = 1
            var lineStart = 0
            for var i = 0; i < dot; i++ {
                if source[i] == '\n' {
                    line++
                    lineStart = i + 1
                }
            }
            let column = dot - lineStart + 2
            return path + "(" + line.ToString() + "," + column.ToString() + "," + line.ToString() +
                "," +
                (column + 5).ToString() + "): error GS0158"
        }

        /// Gets the rejected programs: each is (name, source).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            yield[]object{"ref-local-root-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    x = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-root-write-loop", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    var total int32 = 0
    let ref a C? = x
    if a == nil { return 0 }
    for var i = 0; i < 2; i++ {
        total = total + a.Value
        x = nil
    }
    return total
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-sibling-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    let ref b C? = x
    if a == nil { return 0 }
    b = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"aliased-root-fact-after-alias-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if x == nil { return 0 }
    a = nil
    return x.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-element-index-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var xs = []C?{C{}}
    let ref a C? = xs[0]
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-local-field-member-write", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
}
func Run() int32 {
    let box = Box{}
    let ref a C? = box.Field
    if a == nil { return 0 }
    box.Field = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-parameter-index-write", `
import System

class C {
    var Value int32 = 1
}
func Run(ref a C?, xs []C?) int32 {
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() {
    var xs = []C?{C{}}
    Console.WriteLine(Run(ref xs[0], xs))
}
`}
            yield[]object{"ref-parameters-overlap", `
import System

class C {
    var Value int32 = 1
}
func Run(ref a C?, ref b C?) int32 {
    if a == nil { return 0 }
    b = nil
    return a.Value
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x, ref x))
}
`}
            yield[]object{"ref-locals-same-element", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var xs = []C?{C{}}
    let ref a C? = xs[0]
    let ref b C? = xs[0]
    if a == nil { return 0 }
    b = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"branch-join-alias-write", `
import System

class C {
    var Value int32 = 1
}
func Run(flag bool) int32 {
    var x C? = nil
    let ref a C? = x
    if flag {
        x = C{}
        a = nil
    } else {
        x = C{}
    }
    return x.Value
}
func Main() { Console.WriteLine(Run(true)) }
`}
            yield[]object{"long-alias-chain", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a1 C? = x
    let ref a2 C? = a1
    let ref a3 C? = a2
    let ref a4 C? = a3
    let ref a5 C? = a4
    let ref a6 C? = a5
    let ref a7 C? = a6
    let ref a8 C? = a7
    let ref a9 C? = a8
    let ref a10 C? = a9
    let ref a11 C? = a10
    let ref a12 C? = a11
    let ref a13 C? = a12
    let ref a14 C? = a13
    let ref a15 C? = a14
    let ref a16 C? = a15
    let ref a17 C? = a16
    if a17 == nil { return 0 }
    x = nil
    return a17.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"guard-let-assignment-in-initializer", `
import System

class C {
    var Value int32 = 1
}
func Keep(c C?) C? { return C{} }
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    guard let y = Keep((x = nil)) else { return 0 }
    Console.WriteLine(y == nil)
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-return-provenance", `
import System

class C {
    var Value int32 = 1
}
func Forward(ref value C?) ref C? { return ref value }
func Run() int32 {
    var x C? = C{}
    let ref a C? = Forward(ref x)
    if a == nil { return 0 }
    x = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"loop-root-and-alias-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    var total int32 = 0
    let ref a C? = x
    if x == nil { return 0 }
    for var i = 0; i < 2; i++ {
        total = total + x.Value
        x = C{}
        a = nil
    }
    return total
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"whole-struct-assignment", `
import System

class C {
    var Value int32 = 1
}
struct S {
    var Field C?
}
func Run() int32 {
    var s = S{Field: C{}}
    let empty = S{}
    let ref a C? = s.Field
    if a == nil { return 0 }
    s = empty
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"global-aliased-by-ref-parameter", `
import System

class C {
    var Value int32 = 1
}
var g C? = C{}
func Run(ref a C?) int32 {
    let ref b C? = g
    if b == nil { return 0 }
    a = nil
    return b.Value
}
Console.WriteLine(Run(ref g))
`}
            yield[]object{"getter-clears-aliased-member", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
    prop Clear int32 {
        get {
            Field = nil
            return 1
        }
    }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    let n = box.Clear
    return a.Value + n
}
func Main() {
    let box = Box{}
    Console.WriteLine(Run(ref box.Field, box))
}
`}
            yield[]object{"nested-alias-write-in-assignment", `
import System

class C {
    var Value int32 = 1
}
func Run(flag bool) int32 {
    var x C? = nil
    var y C? = nil
    let ref a C? = x
    if flag {
        x = C{}
        y = (a = nil)
    } else {
        x = C{}
    }
    return x.Value
}
func Main() { Console.WriteLine(Run(true)) }
`}
            yield[]object{"alias-of-global-call", `
import System

class C {
    var Value int32 = 1
}
var g C? = C{}
func Clear() { g = nil }
func Run() int32 {
    let ref a C? = g
    if a == nil { return 0 }
    Clear()
    return a.Value
}
Console.WriteLine(Run())
`}
            yield[]object{"read-only-alias-closure-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    let ref a C? = x
    if a == nil { return 0 }
    clear()
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`}
            yield[]object{"ref-parameter-and-mutable-global", `
import System

class C {
    var Value int32 = 1
}
var g C? = nil
func Run(ref a C?) int32 {
    g = C{}
    a = nil
    return g.Value
}
Console.WriteLine(Run(ref g))
`}
            yield[]object{"guard-let-getter-clears-aliased-member", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
    prop Clear int32? {
        get {
            Field = nil
            return 1
        }
    }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    guard let n = box.Clear else { return 0 }
    return a.Value + n
}
let box = Box{}
Console.WriteLine(Run(ref box.Field, box))
`}
            yield[]object{"literal-initializer-clears-aliased-element", `
import System

class C {
    var Value int32 = 1
}
var store []C? = []C?{C{}}
func Boom() int32 {
    store[0] = nil
    return 1
}
class Maker {
    var n int32 = Boom()
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    let m = Maker{}
    return a.Value + m.n
}
Console.WriteLine(Run(ref store[0]))
`}
            yield[]object{"member-not-null-field-and-ref-parameter", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C?

    @System.Diagnostics.CodeAnalysis.MemberNotNull(members: []string{"Field"})
    func Init() {
        Field = C{}
    }

    func Run(ref a C?) int32 {
        this.Init()
        a = nil
        return Field.Value
    }
}
let box = Box{}
Console.WriteLine(box.Run(ref box.Field))
`}
            yield[]object{"using-let-getter-clears-aliased-member", `
import System

class C {
    var Value int32 = 1
}
class Res : IDisposable {
    func Dispose() { }
}
class Box {
    var Field C? = C{}
    prop Clear Res {
        get {
            Field = nil
            return Res{}
        }
    }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    using let r = box.Clear
    return a.Value
}
let box = Box{}
Console.WriteLine(Run(ref box.Field, box))
`}
            yield[]object{"struct-receiver-and-ref-parameter", `
import System

class C {
    var Value int32 = 1
}
struct S {
    let Field C?

    func Read(ref other S, empty S) int32 {
        if this.Field == nil { return 0 }
        other = empty
        return this.Field.Value
    }
}
var s = S{Field: C{}}
Console.WriteLine(s.Read(ref s, S{}))
`}
            yield[]object{"persistent-address-alias", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let p = managed(x)
    let ref a C? = *p
    if a == nil { return 0 }
    x = nil
    return a.Value
}
Console.WriteLine(Run())
`}
            yield[]object{"property-pattern-getter-clears-aliased-member", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
    prop Clear int32 {
        get {
            Field = nil
            return 1
        }
    }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    let matched = box is { Clear: 1 }
    return a.Value
}
let box = Box{}
Console.WriteLine(Run(ref box.Field, box))
`}
            yield[]object{"callable-stored-through-ref-alias", `
import System

class C {
    var Value int32 = 1
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let ref alias = action
    action = callback
    alias = clear
    if x != nil {
        action()
        return x.Value
    }
    return 0
}
func Main() { Console.WriteLine(Run(() -> { })) }
`}
            yield[]object{"guard-let-getter-before-else", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
    prop Clear int32? {
        get {
            Field = nil
            return nil
        }
    }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    guard let n = box.Clear else { return a.Value }
    return n
}
let box = Box{}
Console.WriteLine(Run(ref box.Field, box))
`}
        }

        /// Gets the accepted programs: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func AcceptedCases() sequence[[]object] {
            yield[]object{"out-parameters-of-interface-and-string-types-do-not-overlap", `
import System

func Describe(items []IDisposable?, out symbol IDisposable?, out name string?) bool {
    symbol = nil
    name = nil
    symbol = items[0]
    if symbol == nil {
        return false
    }
    name = symbol.ToString()
    return symbol.ToString() == name
}
func Main() {
    var symbol IDisposable? = nil
    var name string? = nil
    let items = []IDisposable?{nil}
    Console.WriteLine(Describe(items, out symbol, out name))
}
`, []string{"False"}}
            yield[]object{"ref-argument-to-another-variable-keeps-fact", `
import System

class C {
    var Value int32 = 1
}
func Reset(ref target C?) { target = nil }
func Run(ref a C?, ref b C?) int32 {
    if a == nil { return 0 }
    Reset(ref b)
    return a.Value
}
func Main() {
    var x C? = C{}
    var y C? = C{}
    Console.WriteLine(Run(ref x, ref y))
}
`, []string{"1"}}
            yield[]object{"ref-parameter-survives-read-only-calls", `
import System

class C {
    var Value int32 = 1
}
func Touch(c C) int32 { return c.Value }
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    let first = Touch(a)
    let second = Touch(a)
    return a.Value + first + second
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x))
}
`, []string{"3"}}
            yield[]object{"out-parameter-survives-calls-in-a-loop", `
import System

class C {
    var Value int32 = 1
}
func Touch(c C) int32 { return c.Value }
func Run(out a C?) int32 {
    a = C{}
    if a == nil { return 0 }
    var total int32 = 0
    for var i = 0; i < 3; i++ {
        total += Touch(a) + a.Value
    }
    return total
}
func Main() {
    var x C? = nil
    Console.WriteLine(Run(out x))
}
`, []string{"6"}}
            yield[]object{"out-parameters-of-different-types-do-not-overlap", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
func Lookup(d Dictionary[C, string], key C, out found string?) bool -> d.TryGetValue(key, out found)
func Find(d Dictionary[C, string], c C?, out path C?, out text string?) bool {
    path = c
    if path == nil {
        text = nil
        return false
    }
    for var i = 0; i < 2; i++ {
        if Lookup(d, path, out text) {
            return path.Value > 0
        }
    }
    text = nil
    return false
}
func Main() {
    let c = C{}
    let d = Dictionary[C, string]()
    d[c] = "x"
    var p C? = nil
    var t string? = nil
    Console.WriteLine(Find(d, c, out p, out t))
}
`, []string{"True"}}
            yield[]object{"ref-local-unrelated-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    var y C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    y = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`, []string{"1"}}
            yield[]object{"ref-local-reguard-after-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    x = nil
    if a == nil { return -1 }
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`, []string{"-1"}}
            yield[]object{"ref-local-of-local-survives-index-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    var xs = []C?{C{}}
    let ref a C? = x
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }
`, []string{"1"}}
            yield[]object{"ref-parameter-unrelated-assignment", `
import System

class C {
    var Value int32 = 1
}
func Run(ref a C?) int32 {
    var n int32 = 0
    if a == nil { return 0 }
    n = n + 1
    return a.Value + n
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x))
}
`, []string{"2"}}
            yield[]object{"long-alias-chain-no-write", `
import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a1 C? = x
    let ref a2 C? = a1
    let ref a3 C? = a2
    let ref a4 C? = a3
    let ref a5 C? = a4
    let ref a6 C? = a5
    let ref a7 C? = a6
    let ref a8 C? = a7
    let ref a9 C? = a8
    let ref a10 C? = a9
    let ref a11 C? = a10
    let ref a12 C? = a11
    let ref a13 C? = a12
    let ref a14 C? = a13
    let ref a15 C? = a14
    let ref a16 C? = a15
    let ref a17 C? = a16
    if a17 == nil { return 0 }
    return a17.Value
}
func Main() { Console.WriteLine(Run()) }
`, []string{"1"}}
        }

        private func Compile(dir string, source string, outPath string)(Exit int32, Log string) {
            let srcPath = Path.Combine(dir, Path.GetFileNameWithoutExtension(outPath) + ".gs")
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
            var exit int32
            try {
                exit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exit, compileOut.ToString() + compileErr.ToString())
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
