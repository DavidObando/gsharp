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
    @Theory
    @InlineData("let")
    @InlineData("var")
    func GuardedRefAlias_CannotNarrowNullableStorage(keyword string) {
        let source = `import System
func Run() {
    var text string? = "x"
    if text != nil {
        ` + keyword + ` ref alias string = text
        alias = "keep"
    }
}
Run()
`
        let directory = Path.Combine(AppContext.BaseDirectory, "issue4726", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let output = Path.Combine(directory, "NonNullableAlias.dll")
            let (exit, log) = Compile(directory, source, output)
            Assert.NotEqual(0, exit)
            Assert.False(File.Exists(output))
            let column = source.Split('\n')[4].IndexOf("text", StringComparison.Ordinal) + 1
            Assert.Contains(
                Path.Combine(directory, "NonNullableAlias.gs") + "(5,$column,5,${column + 4}): error GS0155",
                log
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("let", "string?")
    @InlineData("var", "string?")
    @InlineData("let", "")
    @InlineData("var", "")
    func GuardedRefAlias_UsesDeclaredStorageAndInvalidatesReferent(keyword string, typeClause string) {
        let source = `import System
func Run() {
    var text string? = "x"
    if text != nil {
        ` + keyword + ` ref alias ` + typeClause + ` = text
        alias = nil
        Console.WriteLine(text ?? "null")
    }
}
Run()
`
        let directory = Path.Combine(AppContext.BaseDirectory, "issue4726", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let output = Path.Combine(directory, "GuardedAlias.dll")
            let (exit, log) = Compile(directory, source, output)
            Assert.True(exit == 0, log)
            Assert.DoesNotContain("GS0612", log)
            IlVerifier.Verify(output)
            let (runExit, stdout) = RunDotnet(output)
            Assert.Equal(0, runExit)
            Assert.Equal(
                System.Text.Encoding.UTF8.GetBytes("null" + Environment.NewLine),
                System.Text.Encoding.UTF8.GetBytes(stdout)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

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
            yield []object{"ref-local-root-write", `
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
            yield []object{"ref-local-root-write-loop", `
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
            yield []object{"ref-local-sibling-write", `
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
            yield []object{"aliased-root-fact-after-alias-write", `
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
            yield []object{"ref-local-element-index-write", `
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
            yield []object{"ref-local-field-member-write", `
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
            yield []object{"ref-parameter-index-write", `
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
            yield []object{"ref-parameters-overlap", `
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
            yield []object{"ref-locals-same-element", `
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
            yield []object{"branch-join-alias-write", `
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
            yield []object{"long-alias-chain", `
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
            yield []object{"guard-let-assignment-in-initializer", `
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
            yield []object{"ref-return-provenance", `
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
            yield []object{"loop-root-and-alias-write", `
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
            yield []object{"whole-struct-assignment", `
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
            yield []object{"global-aliased-by-ref-parameter", `
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
            yield []object{"getter-clears-aliased-member", `
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
            yield []object{"nested-alias-write-in-assignment", `
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
            yield []object{"alias-of-global-call", `
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
            yield []object{"read-only-alias-closure-write", `
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
            yield []object{"ref-parameter-and-mutable-global", `
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
            yield []object{"guard-let-getter-clears-aliased-member", `
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
            yield []object{"literal-initializer-clears-aliased-element", `
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
            yield []object{"member-not-null-field-and-ref-parameter", `
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
            yield []object{"member-not-null-field-and-other-receiver-write", `
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

    func Run(other Box) int32 {
        this.Init()
        other.Field = nil
        return Field.Value
    }
}
let box = Box{}
Console.WriteLine(box.Run(box))
`}
            yield []object{"member-not-null-field-and-other-receiver-multi-write-loop", `
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

    func Run(other Box) int32 {
        this.Init()
        var total = 0
        for var i = 0; i < 2; i++ {
            total = total + Field.Value
            other.Field, _ = nil, 0
        }
        return total
    }
}
let box = Box{}
Console.WriteLine(box.Run(box))
`}
            yield []object{"member-not-null-field-and-other-receiver-call", `
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

    func Clear() {
        Field = nil
    }

    func Run(other Box) int32 {
        this.Init()
        other.Clear()
        return Field.Value
    }
}
let box = Box{}
Console.WriteLine(box.Run(box))
`}
            yield []object{"using-let-getter-clears-aliased-member", `
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
            yield []object{"struct-receiver-and-ref-parameter", `
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
            yield []object{"persistent-address-alias", `
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
            yield []object{"property-pattern-getter-clears-aliased-member", `
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
            yield []object{"callable-stored-through-ref-alias", `
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
            yield []object{"guard-let-getter-before-else", `
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
            yield []object{"issue-5326-class1-call-writes-global", `
import System

class C {
    var Value int32 = 1
}
var g C? = C{}
func Clear() { g = nil }
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    Clear()
    return a.Value
}
Console.WriteLine(Run(ref g))
`}
            yield []object{"issue-5326-class1-call-writes-static-field", `
import System

class C {
    var Value int32 = 1
}
class Holder {
    shared {
        var Shared C? = C{}
        func Clear() { Shared = nil }
    }
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    Holder.Clear()
    return a.Value
}
Console.WriteLine(Run(ref Holder.Shared))
`}
            yield []object{"issue-5326-class2-call-clears-container-operand", `
import System

class C {
    var Value int32 = 1
}
func Clear(xs []C?) { xs[0] = nil }
func Run(ref a C?, xs []C?) int32 {
    if a == nil { return 0 }
    Clear(xs)
    return a.Value
}
let xs = []C?{C{}}
Console.WriteLine(Run(ref xs[0], xs))
`}
            yield []object{"issue-5326-class2-cyclic-object-self-detach", `
import System

class C {
    var Value int32 = 1
    var Link C?
    func Detach() { Link = nil }
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    a.Detach()
    return a.Value
}
let c = C{}
c.Link = c
Console.WriteLine(Run(ref c.Link))
`}
            yield []object{"issue-5326-class2-loop-call-clears-container-operand", `
import System

class C {
    var Value int32 = 1
}
func Clear(xs []C?) { xs[0] = nil }
func Run(ref a C?, xs []C?) int32 {
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total += a.Value
        Clear(xs)
    }
    return total
}
let xs = []C?{C{}}
Console.WriteLine(Run(ref xs[0], xs))
`}
            yield []object{"issue-5326-class3-interface-dispose-clears-field", `
import System

class C {
    var Value int32 = 1
}
class Holder : IDisposable {
    var Field C? = C{}
    func Dispose() { Field = nil }
}
func Run(ref a C?, d IDisposable) int32 {
    if a == nil { return 0 }
    d.Dispose()
    return a.Value
}
let h = Holder{}
Console.WriteLine(Run(ref h.Field, h))
`}
            yield []object{"issue-5326-class3-open-base-override-clears-field", `
import System

class C {
    var Value int32 = 1
}
open class Base {
    open func Step() { }
}
class Derived : Base {
    var Field C? = C{}
    override func Step() { Field = nil }
}
func Run(ref a C?, b Base) int32 {
    if a == nil { return 0 }
    b.Step()
    return a.Value
}
let d = Derived{}
Console.WriteLine(Run(ref d.Field, d))
`}
            yield []object{"issue-5326-class4-collections-marshal-as-span-clear", `
import System
import System.Collections.Generic
import System.Runtime.InteropServices

class C {
    var Value int32 = 1
}
func ClearList(xs List[C?]) {
    CollectionsMarshal.AsSpan(xs).Clear()
}
func Run(ref a C?, xs List[C?]) int32 {
    if a == nil { return 0 }
    ClearList(xs)
    return a.Value
}
let xs = List[C?](){C{}}
Console.WriteLine(Run(ref CollectionsMarshal.AsSpan(xs)[0], xs))
`}
            yield []object{"issue-5326-class4-queue-copy-to-array", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
func OverwriteFromQueue(q Queue[C?], arr []C?) {
    q.CopyTo(arr, 0)
}
func Run(ref a C?, q Queue[C?], arr []C?) int32 {
    if a == nil { return 0 }
    OverwriteFromQueue(q, arr)
    return a.Value
}
let q = Queue[C?]()
q.Enqueue(nil)
let arr = []C?{C{}}
Console.WriteLine(Run(ref arr[0], q, arr))
`}
            yield []object{"issue-5326-class5-constructed-generic-holder-clear", `
import System

class C {
    var Value int32 = 1
}
class Holder[T] {
    var Item T
    init(item T) { Item = item }
    func Reset() { Item = default(T) }
}
func Run(ref a C?, h Holder[C?]) int32 {
    if a == nil { return 0 }
    h.Reset()
    return a.Value
}
let h = Holder[C?](C{})
Console.WriteLine(Run(ref h.Item, h))
`}
            yield []object{"issue-5326-class5-covariant-array-clear", `
import System

open class Base {
    var Value int32 = 1
}
class C : Base { }
func ClearBase(items []Base?) {
    items[0] = nil
}
func Run(ref a C?, items []Base?) int32 {
    if a == nil { return 0 }
    ClearBase(items)
    return a.Value
}
let xs = []C?{C{}}
Console.WriteLine(Run(ref xs[0], xs))
`}
            yield []object{"issue-5326-class6-dictionary-contains-key-equality-callback", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Key {
    override func GetHashCode() int32 {
        globalC = nil
        return 0
    }
    override func Equals(obj object?) bool -> true
}
func Probe(d Dictionary[Key, int32], k Key) bool -> d.ContainsKey(k)
func Run(ref a C?, d Dictionary[Key, int32], k Key) int32 {
    if a == nil { return 0 }
    let _ = Probe(d, k)
    return a.Value
}
let d = Dictionary[Key, int32]()
d[Key{}] = 1
globalC = C{}
Console.WriteLine(Run(ref globalC, d, Key{}))
`}
            yield []object{"issue-5326-class6-string-builder-append-tostring-callback", `
import System
import System.Text

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Evil {
    override func ToString() string {
        globalC = nil
        return ""
    }
}
func FormatItem(sb StringBuilder, item object) {
    let _ = sb.Append(item)
}
func Run(ref a C?, sb StringBuilder, item object) int32 {
    if a == nil { return 0 }
    FormatItem(sb, item)
    return a.Value
}
Console.WriteLine(Run(ref globalC, StringBuilder(), Evil{}))
`}
            yield []object{"issue-5326-class7-interlocked-exchange-clears-field", `
import System
import System.Threading

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
    func ClearAtomically() {
        let _ = Interlocked.Exchange(&Field, nil)
    }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    box.ClearAtomically()
    return a.Value
}
let box = Box{}
Console.WriteLine(Run(ref box.Field, box))
`}
            yield []object{"issue-5326-tuple-element-ref-alias-cleared-by-slot-write", `
import System

class C {
    var Value int32 = 1
}
var globalPair (C?, int32) = (C{}, 1)
func ClearSlot() {
    globalPair.Item1 = nil
}
func Run(ref row (C?, int32)) int32 {
    let ref a = row.Item1
    if a == nil { return 0 }
    ClearSlot()
    return a.Value
}
Console.WriteLine(Run(ref globalPair))
`}
            yield []object{"issue-5326-structural-equality-callback-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Trigger {
    override func Equals(obj object?) bool {
        globalC = nil
        return true
    }
    override func GetHashCode() int32 -> 0
}
data struct Pair(Item Trigger)
func Run(ref a C?, x Pair, y Pair) int32 {
    if a == nil { return 0 }
    let same = x == y
    if same {
        return a.Value
    }
    return 0
}
let t = Pair(Trigger{})
Console.WriteLine(Run(ref globalC, t, t))
`}
            yield []object{"issue-5326-nested-equality-callback-clears-global", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class InnerKey {
    override func GetHashCode() int32 {
        globalC = nil
        return 0
    }
    override func Equals(obj object?) bool -> true
}
class OuterKey {
    var Inner Dictionary[InnerKey, int32] = Dictionary[InnerKey, int32]()
    override func GetHashCode() int32 {
        let _ = Inner.ContainsKey(InnerKey{})
        return 0
    }
    override func Equals(obj object?) bool -> true
}
func ProbeOuter(d Dictionary[OuterKey, int32], k OuterKey) bool -> d.ContainsKey(k)
func Run(ref a C?, d Dictionary[OuterKey, int32], k OuterKey) int32 {
    if a == nil { return 0 }
    let _ = ProbeOuter(d, k)
    return a.Value
}
let outer = OuterKey{}
outer.Inner[InnerKey{}] = 1
let d = Dictionary[OuterKey, int32]()
d[outer] = 1
globalC = C{}
Console.WriteLine(Run(ref globalC, d, outer))
`}
            yield []object{"issue-5326-interpolated-string-tostring-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Noisy {
    override func ToString() string {
        globalC = nil
        return "n"
    }
}
func Run(ref a C?, noisy Noisy) int32 {
    if a == nil { return 0 }
    let _ = "item=${noisy}"
    return a.Value
}
Console.WriteLine(Run(ref globalC, Noisy{}))
`}
            yield []object{"issue-5326-list-foreach-callback-clears-global", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
var globalC C? = C{}
var globalAction Action[int32] = (x int32) -> { globalC = nil }
func RunAll(xs List[int32]) {
    xs.ForEach(globalAction)
}
func Run(ref a C?, xs List[int32]) int32 {
    if a == nil { return 0 }
    RunAll(xs)
    return a.Value
}
let xs = List[int32](){1}
Console.WriteLine(Run(ref globalC, xs))
`}
            yield []object{"issue-5326-parameter-callback-wrapper-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func InvokeCallback(cb () -> void) {
    cb()
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    InvokeCallback(() -> { globalC = nil })
    return a.Value
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-struct-literal-field-initializer-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func ClearGlobal() int32 {
    globalC = nil
    return 1
}
class Reset {
    var N int32 = ClearGlobal()
}
func MakeReset() {
    let _ = Reset{}
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    MakeReset()
    return a.Value
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-user-toarray-returns-shared-buffer", `
import System

class C {
    var Value int32 = 1
}
class BufferHolder {
    var Items []C? = []C?{C{}}
    func ToArray() []C? -> Items
}
func ClearViaToArray(h BufferHolder) {
    let xs = h.ToArray()
    xs[0] = nil
}
func Run(ref a C?, h BufferHolder) int32 {
    if a == nil { return 0 }
    ClearViaToArray(h)
    return a.Value
}
let h = BufferHolder{}
Console.WriteLine(Run(ref h.Items[0], h))
`}
            yield []object{"issue-5326-nested-named-callback-wrapper-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func InvokeCallback(cb () -> void) {
    cb()
}
func WrapCallback() {
    InvokeCallback(() -> { globalC = nil })
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    WrapCallback()
    return a.Value
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-enumerable-any-callback-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func CheckAny(xs List[int32]) bool {
    return xs.Any((x int32) -> {
        globalC = nil
        return x > 0
    })
}
func Run(ref a C?, xs List[int32]) int32 {
    if a == nil { return 0 }
    let _ = CheckAny(xs)
    return a.Value
}
let xs = List[int32](){1}
Console.WriteLine(Run(ref globalC, xs))
`}
            yield []object{"issue-5326-callee-interpolation-tostring-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Noisy {
    override func ToString() string {
        globalC = nil
        return "n"
    }
}
func FormatNoisy(noisy Noisy) string {
    return "item=${noisy}"
}
func Run(ref a C?, noisy Noisy) int32 {
    if a == nil { return 0 }
    let _ = FormatNoisy(noisy)
    return a.Value
}
Console.WriteLine(Run(ref globalC, Noisy{}))
`}
            yield []object{"issue-5326-constant-pattern-equals-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class E {
    override func Equals(o object?) bool {
        globalC = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
func Run(ref a C?, o object) int32 {
    if a == nil { return 0 }
    let matched = o is 1
    return a.Value
}
Console.WriteLine(Run(ref globalC, E{}))
`}
            yield []object{"issue-5326-loop-structural-equality-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Trigger {
    override func Equals(obj object?) bool {
        globalC = nil
        return true
    }
    override func GetHashCode() int32 -> 0
}
data struct Pair(Item Trigger)
func Run(ref a C?, x Pair, y Pair) int32 {
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total += a.Value
        let _ = x == y
    }
    return total
}
let t = Pair(Trigger{})
Console.WriteLine(Run(ref globalC, t, t))
`}
            yield []object{"issue-5326-loop-source-operator-interpolation-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Noisy {
    override func ToString() string {
        globalC = nil
        return "n"
    }
}
struct Token {
    var Id int32
}
func (a Token) operator +(b Token) Noisy -> Noisy{}
func Run(ref a C?, token Token) int32 {
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total += a.Value
        let _ = "${token + token}"
    }
    return total
}
Console.WriteLine(Run(ref globalC, Token{Id: 1}))
`}
            yield []object{"issue-5326-base-call-callback-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
open class BaseRunner {
    open func Invoke(cb () -> void) {
        cb()
    }
}
class DerivedRunner : BaseRunner {
    func Wrap() {
        base.Invoke(() -> { globalC = nil })
    }
}
func Run(ref a C?, d DerivedRunner) int32 {
    if a == nil { return 0 }
    d.Wrap()
    return a.Value
}
Console.WriteLine(Run(ref globalC, DerivedRunner{}))
`}
            yield []object{"issue-5326-equality-comparer-create-clears-global", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Run(ref a C?, d Dictionary[int32, int32]) int32 {
    if a == nil { return 0 }
    let _ = d.ContainsKey(1)
    return a.Value
}
let cmp = EqualityComparer[int32].Create(
    (x int32, y int32) -> x == y,
    (x int32) -> {
        globalC = nil
        return x
    }
)
let d = Dictionary[int32, int32](cmp)
d[1] = 1
globalC = C{}
Console.WriteLine(Run(ref globalC, d))
`}
            yield []object{"issue-5326-enumerable-count-deferred-where-callback-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Run(ref a C?, seq IEnumerable[int32]) int32 {
    if a == nil { return 0 }
    let n = Enumerable.Count(seq)
    return a.Value + n
}
let xs = List[int32](){1}
let seq = xs.Where((x int32) -> {
    globalC = nil
    return true
})
Console.WriteLine(Run(ref globalC, seq))
`}
            yield []object{"issue-5326-local-function-callback-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Wrap() {
    func Invoke(cb () -> void) {
        cb()
    }
    Invoke(() -> { globalC = nil })
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    Wrap()
    return a.Value
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-priority-queue-enqueue-comparer-clears-global", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class PrioComparer : IComparer[int32] {
    func Compare(x int32, y int32) int32 {
        globalC = nil
        return 0
    }
}
func Run(ref a C?, pq PriorityQueue[string, int32]) int32 {
    if a == nil { return 0 }
    pq.Enqueue("b", 2)
    return a.Value
}
let pq = PriorityQueue[string, int32](PrioComparer{})
pq.Enqueue("a", 1)
globalC = C{}
Console.WriteLine(Run(ref globalC, pq))
`}
            yield []object{"issue-5326-string-create-format-provider-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class ClearingProvider : IFormatProvider {
    func GetFormat(formatType Type?) object? {
        globalC = nil
        return nil
    }
}
func Run(ref a C?, provider IFormatProvider) int32 {
    if a == nil { return 0 }
    let _ = string.Create(provider, "${1}")
    return a.Value
}
Console.WriteLine(Run(ref globalC, ClearingProvider{}))
`}
            yield []object{"issue-5326-callee-operator-interpolation-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Noisy {
    override func ToString() string {
        globalC = nil
        return "n"
    }
}
struct Token {
    var Id int32
}
func (a Token) operator +(b Token) Noisy -> Noisy{}
func FormatToken(token Token) string {
    return "${token + token}"
}
func Run(ref a C?, token Token) int32 {
    if a == nil { return 0 }
    let _ = FormatToken(token)
    return a.Value
}
Console.WriteLine(Run(ref globalC, Token{Id: 1}))
`}
            yield []object{"issue-5326-cancellation-token-source-cancel-clears-global", `
import System
import System.Threading

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Run(ref a C?, cts CancellationTokenSource) int32 {
    if a == nil { return 0 }
    cts.Cancel()
    return a.Value
}
using let cts = CancellationTokenSource()
let _ = cts.Token.Register(() -> { globalC = nil })
Console.WriteLine(Run(ref globalC, cts))
`}
            yield []object{"issue-5326-callee-binary-operator-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
struct Token {
    var Id int32
}
func (a Token) operator +(b Token) int32 {
    globalC = nil
    return a.Id + b.Id
}
func AddTokens(t Token) int32 {
    return t + t
}
func Run(ref a C?, t Token) int32 {
    if a == nil { return 0 }
    let _ = AddTokens(t)
    return a.Value
}
Console.WriteLine(Run(ref globalC, Token{Id: 1}))
`}
            yield []object{"issue-5326-distinctby-deferred-callback-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Run(ref a C?, seq IEnumerable[int32]) int32 {
    if a == nil { return 0 }
    let n = Enumerable.Count(seq)
    return a.Value + n
}
let xs = List[int32](){1}
let seq = xs.DistinctBy((x int32) -> {
    globalC = nil
    return x
})
Console.WriteLine(Run(ref globalC, seq))
`}
            yield []object{"issue-5326-where-method-group-callback-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func ClearPredicate(x int32) bool {
    globalC = nil
    return true
}
func Run(ref a C?, seq IEnumerable[int32]) int32 {
    if a == nil { return 0 }
    let n = Enumerable.Count(seq)
    return a.Value + n
}
let xs = List[int32](){1}
let seq = xs.Where(ClearPredicate)
Console.WriteLine(Run(ref globalC, seq))
`}
            yield []object{"issue-5326-count-global-helper-deferred-where-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
let xs = List[int32](){1}
var globalSeq IEnumerable[int32] = xs.Where((x int32) -> {
    globalC = nil
    return true
})
func CountGlobal() int32 {
    return Enumerable.Count(globalSeq)
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    let n = CountGlobal()
    return a.Value + n
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-yield-iterator-deferred-count-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Items() sequence[int32] {
    globalC = nil
    yield 1
}
func Run(ref a C?, seq IEnumerable[int32]) int32 {
    if a == nil { return 0 }
    let n = Enumerable.Count(seq)
    return a.Value + n
}
let seq = Items()
Console.WriteLine(Run(ref globalC, seq))
`}
            yield []object{"issue-5326-loop-enumerable-toarray-deferred-where-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Run(ref a C?, seq IEnumerable[int32]) int32 {
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total += a.Value
        let _ = seq.ToArray()
    }
    return total
}
let xs = List[int32](){1}
let seq = xs.Where((x int32) -> {
    globalC = nil
    return true
})
Console.WriteLine(Run(ref globalC, seq))
`}
            yield []object{"issue-5326-concurrent-dictionary-getoradd-callback-clears-global", `
import System
import System.Collections.Concurrent

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Populate(d ConcurrentDictionary[int32, int32]) int32 {
    return d.GetOrAdd(1, (k int32) -> {
        globalC = nil
        return k
    })
}
func Run(ref a C?, d ConcurrentDictionary[int32, int32]) int32 {
    if a == nil { return 0 }
    let n = Populate(d)
    return a.Value + n
}
let d = ConcurrentDictionary[int32, int32]()
Console.WriteLine(Run(ref globalC, d))
`}
            yield []object{"issue-5326-count-global-via-local-copy-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
let xs = List[int32](){1}
var globalSeq IEnumerable[int32] = xs.Where((x int32) -> {
    globalC = nil
    return true
})
func CountGlobalViaLocal() int32 {
    let local = globalSeq
    return Enumerable.Count(local)
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    let n = CountGlobalViaLocal()
    return a.Value + n
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-equality-comparer-create-method-group-clears-global", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func SameInt(x int32, y int32) bool -> x == y
func HashAndClear(x int32) int32 {
    globalC = nil
    return x
}
func Run(ref a C?, d Dictionary[int32, int32]) int32 {
    if a == nil { return 0 }
    let _ = d.ContainsKey(1)
    return a.Value
}
let cmp = EqualityComparer[int32].Create(SameInt, HashAndClear)
let d = Dictionary[int32, int32](cmp)
d[1] = 1
globalC = C{}
Console.WriteLine(Run(ref globalC, d))
`}
            yield []object{"issue-5326-fresh-receiver-property-setter-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Scratch {
    prop Tag int32 {
        get -> 0
        set {
            globalC = nil
        }
    }
}
func TouchScratch() {
    let s = Scratch{}
    s.Tag = 1
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    TouchScratch()
    return a.Value
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-loop-interpolated-handler-primitive-hole-clears-global", `
import System
import System.Runtime.CompilerServices

class C {
    var Value int32 = 1
}
var globalC C? = C{}
@InterpolatedStringHandler
struct ClearHandler {
    init(literalLength int32, formattedCount int32) { }
    func AppendLiteral(s string) { }
    func AppendFormatted(v bool) {
        globalC = nil
    }
}
func Sink(h ClearHandler) { }
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total += a.Value
        Sink("${true}")
    }
    return total
}
Console.WriteLine(Run(ref globalC))
`}
            yield []object{"issue-5326-callee-reads-lazy-value-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func ReadLazy(l Lazy[int32]) int32 -> l.Value
func Run(ref a C?, l Lazy[int32]) int32 {
    if a == nil { return 0 }
    let _ = ReadLazy(l)
    return a.Value
}
let lazyVal = Lazy[int32](() -> {
    globalC = nil
    return 7
})
Console.WriteLine(Run(ref globalC, lazyVal))
`}
            yield []object{"issue-5326-deferred-enumerable-distinct-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Key {
    override func GetHashCode() int32 {
        globalC = nil
        return 0
    }
    override func Equals(other object?) bool -> true
}
func Run(ref a C?, seq IEnumerable[Key]) int32 {
    if a == nil { return 0 }
    let _ = seq.ToArray()
    return a.Value
}
let keys = List[Key](){Key{}}
let distinctSeq = keys.Distinct()
globalC = C{}
Console.WriteLine(Run(ref globalC, distinctSeq))
`}
            yield []object{"issue-5326-tuple-interpolation-element-tostring-clears-global", `
import System

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Noisy {
    override func ToString() string {
        globalC = nil
        return "noisy"
    }
}
func Run(ref a C?, row (Noisy, int32)) int32 {
    if a == nil { return 0 }
    let _ = "${row}"
    return a.Value
}
Console.WriteLine(Run(ref globalC, (Noisy{}, 1)))
`}
            yield []object{"issue-5326-hashset-setequals-clears-global", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Key {
    override func GetHashCode() int32 {
        globalC = nil
        return 0
    }
    override func Equals(other object?) bool -> true
}
func Run(ref a C?, set HashSet[Key], other []Key) int32 {
    if a == nil { return 0 }
    let _ = set.SetEquals(other)
    return a.Value
}
let set = HashSet[Key]()
globalC = C{}
Console.WriteLine(Run(ref globalC, set, []Key{Key{}}))
`}
            yield []object{"issue-5326-enumerable-max-compareto-clears-global", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
class Item : IComparable[Item] {
    func CompareTo(other Item?) int32 {
        globalC = nil
        return 0
    }
}
func Run(ref a C?, items List[Item]) int32 {
    if a == nil { return 0 }
    let _ = items.Max()
    return a.Value
}
let items = List[Item](){Item{}, Item{}}
globalC = C{}
Console.WriteLine(Run(ref globalC, items))
`}
        }

        /// Gets the accepted programs: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func AcceptedCases() sequence[[]object] {
            yield []object{"conditional-in-argument-of-imported-call-keeps-the-fact", `
import System
import System.Runtime.CompilerServices

class C {
    var Value int32 = 1
}
func Run(flag bool) int32 {
    var x C? = C{}
    if x == nil { return 0 }
    let missing = Unsafe.IsNullRef[C?](in flag ? x : x)
    if missing { return -1 }
    return x.Value
}
func Main() {
    Console.WriteLine(Run(true))
}
`, []string{"1"}}
            yield []object{"in-argument-keeps-the-fact", `
import System

class C {
    var Value int32 = 1
}
func Touch(in target C?) { }
func Run() int32 {
    var x C? = C{}
    if x == nil { return 0 }
    Touch(in x)
    return x.Value
}
func Main() {
    Console.WriteLine(Run())
}
`, []string{"1"}}
            yield []object{"conditional-in-argument-keeps-the-fact", `
import System

class C {
    var Value int32 = 1
}
func Touch(in target C?) { }
func Run(flag bool) int32 {
    var x C? = C{}
    if x == nil { return 0 }
    Touch(in flag ? x : x)
    return x.Value
}
func Main() {
    Console.WriteLine(Run(true))
}
`, []string{"1"}}
            yield []object{"conditional-address-argument-counts-the-variable-once", `
import System

class C {
    var Value int32 = 1
}
func Touch(ref target C?) { }
func Run(ref a C?, ref b C?, flag bool) int32 {
    if a == nil { return 0 }
    Touch(ref flag ? b : b)
    return a.Value
}
func Main() {
    var x C? = C{}
    var y C? = C{}
    Console.WriteLine(Run(ref x, ref y, true))
}
`, []string{"1"}}
            yield []object{"object-and-class-by-reference-parameters-do-not-overlap", `
import System

class C {
    var Value int32 = 1
}
func Run(ref a C?, ref other object?) int32 {
    if a == nil { return 0 }
    other = nil
    return a.Value
}
func Main() {
    var x C? = C{}
    var y object? = "text"
    Console.WriteLine(Run(ref x, ref y))
}
`, []string{"1"}}
            yield []object{"out-parameters-of-interface-and-string-types-do-not-overlap", `
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
            yield []object{"ref-argument-to-another-variable-keeps-fact", `
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
            yield []object{"ref-parameter-survives-read-only-calls", `
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
            yield []object{"out-parameter-survives-calls-in-a-loop", `
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
            yield []object{"out-parameters-of-different-types-do-not-overlap", `
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
            yield []object{"ref-local-unrelated-write", `
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
            yield []object{"ref-local-reguard-after-write", `
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
            yield []object{"ref-local-of-local-survives-index-write", `
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
            yield []object{"ref-parameter-unrelated-assignment", `
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
            yield []object{"long-alias-chain-no-write", `
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
            yield []object{"issue-5326-safe-call-writes-unrelated-field-type", `
import System

class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
    var Count int32 = 0
    func BumpCount() { Count = Count + 1 }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    box.BumpCount()
    return a.Value + box.Count
}
func Main() {
    let box = Box{}
    Console.WriteLine(Run(ref box.Field, box))
}
`, []string{"2"}}
            yield []object{"issue-5326-safe-call-mutates-fresh-local-container", `
import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
func BuildScratchCount(seed C) int32 {
    let scratch = List[C?]()
    scratch.Add(seed)
    scratch.Add(nil)
    return scratch.Count
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    let n = BuildScratchCount(a)
    return a.Value + n
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x))
}
`, []string{"3"}}
            yield []object{"issue-5326-safe-generic-call-writes-unrelated-instantiation", `
import System

class C {
    var Value int32 = 1
}
class Holder[T] {
    var Item T
    init(item T) { Item = item }
    func Reset() { Item = default(T) }
}
func Run(ref a C?, other Holder[string?]) int32 {
    if a == nil { return 0 }
    other.Reset()
    return a.Value
}
func Main() {
    var x C? = C{}
    let other = Holder[string?]("hi")
    Console.WriteLine(Run(ref x, other))
}
`, []string{"1"}}
            yield []object{"issue-5326-safe-base-method-call-preserves-narrowing", `
import System

class C {
    var Value int32 = 1
}
open class BaseWorker {
    open func Noop() int32 -> 4
}
class DerivedWorker : BaseWorker {
    func Run(ref a C?) int32 {
        if a == nil { return 0 }
        let n = base.Noop()
        return a.Value + n
    }
}
func Main() {
    var x C? = C{}
    let w = DerivedWorker{}
    Console.WriteLine(w.Run(ref x))
}
`, []string{"5"}}
            yield []object{"issue-5326-safe-loop-primitive-interpolation-preserves-narrowing", `
import System

class C {
    var Value int32 = 1
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total += a.Value
        let _ = "${i + 1}"
    }
    return total
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x))
}
`, []string{"2"}}
            yield []object{"issue-5326-safe-ignore-enumerable-preserves-narrowing", `
import System
import System.Collections.Generic
import System.Linq

class C {
    var Value int32 = 1
}
var globalC C? = C{}
func Ignore(seq IEnumerable[int32]) { }
func Run(ref a C?, seq IEnumerable[int32]) int32 {
    if a == nil { return 0 }
    Ignore(seq)
    return a.Value
}
let xs = List[int32](){1}
let seq = xs.Where((x int32) -> {
    globalC = nil
    return true
})
Console.WriteLine(Run(ref globalC, seq))
`, []string{"1"}}
            yield []object{"issue-5326-safe-elided-conditional-call-preserves-narrowing", `
import System
import System.Diagnostics

class C {
    var Value int32 = 1
}
var globalC C? = C{}
@Conditional("NEVER_DEFINED_SYMBOL_5326")
func ElidedClear() {
    globalC = nil
}
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    ElidedClear()
    return a.Value
}
Console.WriteLine(Run(ref globalC))
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
