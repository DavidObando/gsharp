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
