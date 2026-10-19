// <copyright file="Issue4967NullCoalescingAssignmentExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #4967 / ADR-0072 (amended): `??=` is an expression, like every
/// other assignment operator. Each test compiles via in-process `gsc`,
/// IL-verifies the emitted PE, and runs it under `dotnet exec`, asserting
/// captured stdout: the value (the target's final value), single evaluation
/// of the target's receiver and indices, and a right side evaluated only
/// when the target is nil.
open class Issue4967NullCoalescingAssignmentExpressionEmitTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func StructReceivers_ConstrainedGenericIndexer_PreservesDispatch(valuePosition bool, refTarget bool) {
        let source = `package Test
import System
import System.Collections.Generic
func Fill[T IList[string?]](input T) string? {
    var items = input
    var ref alias = items
    ASSIGN
}
let values = []string?{nil}
let segment = ArraySegment[string?](values)
Console.WriteLine(Fill(segment))
Console.WriteLine(Fill(segment))
Console.WriteLine(values[0])`.Replace(
            "ASSIGN",
            if valuePosition {
                `return TARGET[0] ??= "v"`
            } else {
                `TARGET[0] ??= "v"
    return items[0]`
            }
        )
            .Replace(
            "TARGET",
            if refTarget {
                "alias"
            } else {
                "items"
            }
        )
        Assert.Equal("v${Environment.NewLine}v${Environment.NewLine}v${Environment.NewLine}", CompileAndRun(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructReceivers_ProjectedGenericClrField_UsesSymbolicStorage(constrainedReceiver bool) {
        let source = `package Test
import System
import System.Runtime.CompilerServices
FUNCTION
Console.WriteLine(CALL)`.Replace(
            "FUNCTION",
            if constrainedReceiver {
                `func Compare[T IComparable[T]](box StrongBox[T], other T) int32 -> box.Value.CompareTo(other)`
            } else {
                `func Count[T](box StrongBox[ArraySegment[T]]) int32 -> box.Value.Count`
            }
        )
            .Replace(
            "CALL",
            if constrainedReceiver {
                `Compare(StrongBox[int32](7), 3)`
            } else {
                `Count(StrongBox[ArraySegment[int32]](ArraySegment[int32]([]int32{7, 3})))`
            }
        )
        Assert.Equal(
            (
                if constrainedReceiver {
                    "1"
                } else {
                    "2"
                }
            ) +
                Environment.NewLine,
            CompileAndRun(source)
        )
    }

    /// The issue's exact repro: `??=` is accepted in value position like `=` and `+=`.
    @Fact
    func Issue4967_Repro_ExpressionAndStatementFormsAgree() {
        let source = `package Test
import System
var x = 0
let a = (x = 5)
let b = (x += 4)
Console.WriteLine("${a} ${b} ${x}")
var s string? = nil
s ??= "stmt"
Console.WriteLine(s)
var t string? = nil
let r = (t ??= "expr")
Console.WriteLine("${r} ${t}")`
        Assert.Equal(
            "5 9 9${Environment.NewLine}stmt${Environment.NewLine}expr expr${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// `a[i()] ??= v()` evaluates `i()` once per evaluation, `v()` only when the element is nil, and yields the final element value.
    @Fact
    func Indexer_ReceiverAndIndexEvaluatedOnce_RhsOnlyWhenNil() {
        let source = `package Test
import System

var log = ""
func i() int32 {
    log += "i"
    return 0
}
func v(s string) string {
    log += "v"
    return s
}

func main() {
    var a = []string?{nil}
    let first = (a[i()] ??= v("one"))
    Console.WriteLine("${first} ${log}")
    let second = (a[i()] ??= v("two"))
    Console.WriteLine("${second} ${log} ${a[0]}")
}

main()`
        Assert.Equal("one iv${Environment.NewLine}one ivi one${Environment.NewLine}", CompileAndRun(source))
    }

    /// `o().F ??= v()` evaluates the receiver once and the right side only when the field is nil.
    @Fact
    func MemberReceiverEvaluatedOnce_RhsOnlyWhenNil() {
        let source = `package Test
import System

class Box {
    var F string?
}
var log = ""
func o(b Box) Box {
    log += "o"
    return b
}
func v(s string) string {
    log += "v"
    return s
}

func main() {
    let b = Box{}
    let first = (o(b).F ??= v("one"))
    let second = (o(b).F ??= v("two"))
    Console.WriteLine("${first} ${second} ${log} ${b.F}")
}

main()`
        Assert.Equal("one one ovo one${Environment.NewLine}", CompileAndRun(source))
    }

    /// A property target is read through its getter once per `??=` and written through its setter only when nil; the value is never a re-read.
    @Fact
    func Property_GetterOncePerEvaluation_SetterOnlyWhenNil() {
        let source = `package Test
import System

class Counter {
    var gets int32
    var sets int32
    var backing string?
    prop P string? {
        get {
            gets++
            return backing
        }
        set {
            sets++
            backing = value
        }
    }
}

func main() {
    let c = Counter{}
    let first = (c.P ??= "one")
    Console.WriteLine("${first} gets=${c.gets} sets=${c.sets}")
    let second = (c.P ??= "two")
    Console.WriteLine("${second} gets=${c.gets} sets=${c.sets}")
}

main()`
        Assert.Equal(
            "one gets=1 sets=1${Environment.NewLine}one gets=2 sets=1${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// `int32? ??= int32` yields `int32` (C#: the underlying type when the right side converts to it).
    @Fact
    func NullableValueType_ResultIsUnderlyingType() {
        let source = `package Test
import System

func main() {
    var n int32? = nil
    let first int32 = (n ??= 42)
    let second int32 = (n ??= 7)
    Console.WriteLine("${first} ${second} ${n}")
}

main()`
        Assert.Equal("42 42 42${Environment.NewLine}", CompileAndRun(source))
    }

    /// `??=` works as a call argument, a `return` value, a lambda body and inside a larger expression.
    @Fact
    func ValuePositions_ArgumentReturnLambdaAndCondition() {
        let source = `package Test
import System

func show(s string) string -> "[" + s + "]"
func pick(x string?) string {
    var y = x
    return y ??= "default"
}

func main() {
    var s string? = nil
    Console.WriteLine(show(s ??= "arg"))
    Console.WriteLine(pick(nil) + " " + pick("given"))
    var w string? = nil
    let f () -> string = () -> w ??= "lambda"
    Console.WriteLine(f() + " " + w!!)
    var m string? = nil
    Console.WriteLine((m ??= "abc").Length + 1)
}

main()`
        Assert.Equal(
            "[arg]${Environment.NewLine}default given${Environment.NewLine}lambda lambda${Environment.NewLine}4${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// `a ??= b ??= c` is `a ??= (b ??= c)`, as in C#; the inner assignment runs only when `a` is nil.
    @Fact
    func Chained_IsRightAssociative() {
        let source = `package Test
import System

func main() {
    var a string? = nil
    var b string? = nil
    let r = (a ??= b ??= "c")
    Console.WriteLine("${r} ${a} ${b}")
    var c string? = "kept"
    var d string? = nil
    let r2 = (c ??= d ??= "unused")
    Console.WriteLine("${r2} ${c} ${d ?? "nil"}")
}

main()`
        Assert.Equal("c c c${Environment.NewLine}kept kept nil${Environment.NewLine}", CompileAndRun(source))
    }

    /// A right side that may be nil keeps the result `T?`; nil is stored and yielded.
    @Fact
    func NullableRhs_YieldsNullableResult() {
        let source = `package Test
import System

func main() {
    var maybe string? = nil
    var t string? = nil
    let r string? = (t ??= maybe)
    Console.WriteLine(r ?? "nil")
    var n int32? = nil
    var other int32? = nil
    let k int32? = (n ??= other)
    Console.WriteLine(k ?? -1)
}

main()`
        Assert.Equal("nil${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    /// A CLR indexer target (`Dictionary`) evaluates its receiver and key once in value position.
    @Fact
    func CompositeIndexer_EvaluatesKeyOnce() {
        let source = `package Test
import System
import System.Collections.Generic

var log = ""
func key() string {
    log += "k"
    return "k"
}

func main() {
    let d = Dictionary[string, string?]()
    d["k"] = nil
    let first = (d[key()] ??= "set")
    let second = (d[key()] ??= "ignored")
    Console.WriteLine("${first} ${second} ${log} ${d["k"]}")
}

main()`
        Assert.Equal("set set kk set${Environment.NewLine}", CompileAndRun(source))
    }

    /// An awaited right side spills correctly in statement and value position and runs only when the target is nil.
    @Fact
    func AwaitRhs_InBothPositions_RunsOnlyWhenNil() {
        let source = `package Test
import System
import System.Threading.Tasks

var log = ""
async func get(s string) string {
    await Task.Yield()
    log += s
    return s
}
async func run() string {
    var a string? = nil
    a ??= await get("a")
    let kept = (a ??= await get("x"))
    var b string? = nil
    let made = (b ??= await get("b"))
    return "${kept} ${made} ${log}"
}

func main() {
    Console.WriteLine(run().Result)
}

main()`
        Assert.Equal("a b ab${Environment.NewLine}", CompileAndRun(source))
    }

    /// `yield x ??= v` yields the final value in an iterator.
    @Fact
    func IteratorYield_ValuePosition() {
        let source = `package Test
import System

func gen() sequence[string] {
    var x string? = nil
    yield x ??= "first"
    yield x ??= "second"
}

func main() {
    for s in gen() {
        Console.WriteLine(s)
    }
}

main()`
        Assert.Equal("first${Environment.NewLine}first${Environment.NewLine}", CompileAndRun(source))
    }

    /// Statement-position `??=` (also in a for-header post statement) keeps its behavior.
    @Fact
    func ForHeaderAndStatement_Unchanged() {
        let source = `package Test
import System

func main() {
    var count = 0
    for var i string? = nil; i == nil; i ??= "done" {
        count++
    }
    var s string? = "keep"
    s ??= "lost"
    Console.WriteLine("${count} ${s}")
}

main()`
        Assert.Equal("1 keep${Environment.NewLine}", CompileAndRun(source))
    }

    /// Review of #4980: the value is converted to the target once, so a boxed value stored in an `object?` target is the same object the expression yields.
    @Fact
    func BoxedValue_StoredAndYieldedValueAreTheSameObject() {
        let source = `package Test
import System

func main() {
    var x object? = nil
    let r = (x ??= 42)
    Console.WriteLine("${object.ReferenceEquals(x, r)} ${r}")
    var big int64? = nil
    let widened int64 = (big ??= 5)
    Console.WriteLine(widened)
}

main()`
        Assert.Equal("True 42${Environment.NewLine}5${Environment.NewLine}", CompileAndRun(source))
    }

    /// Review of #4980: a throwing right side is the coalesce fallback, in statement and value position; it runs only when the target is nil.
    @Fact
    func ThrowingRhs_StatementAndValuePositions() {
        let source = `package Test
import System

func main() {
    var s string? = "kept"
    s ??= throw Exception("missing")
    Console.WriteLine(s)
    var t string? = "also kept"
    let k = (t ??= throw Exception("missing"))
    Console.WriteLine(k)
    var u string? = nil
    try {
        let _ = (u ??= throw Exception("thrown"))
    } catch (e Exception) {
        Console.WriteLine(e.Message)
    }
    try {
        u ??= throw Exception("thrown again")
    } catch (e Exception) {
        Console.WriteLine(e.Message)
    }
}

main()`
        Assert.Equal(
            "kept${Environment.NewLine}also kept${Environment.NewLine}thrown${Environment.NewLine}thrown again${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// Lambda and method-group right sides are target-typed by the nullable function-typed target in both positions.
    @Fact
    func LambdaAndMethodGroupRhs_TargetTyped() {
        let source = `package Test
import System

class Holder {
    var F (() -> int32)?
}
func seven() int32 -> 7

func main() {
    let h = Holder{}
    h.F ??= () -> 3
    var g (() -> int32)? = nil
    let picked = (g ??= seven)
    Console.WriteLine("${h.F!!()} ${picked()}")
}

main()`
        Assert.Equal("3 7${Environment.NewLine}", CompileAndRun(source))
    }

    /// The statement form keeps its lowering (`if read == nil { write }`),
    /// so its existing flow facts are unchanged: after `t ??= throw e` the
    /// target is non-nil on every path that continues and stays narrowed.
    @Fact
    func Statement_ThrowingRhs_KeepsItsNarrowing() {
        let source = `package Test
import System

func main() {
    var t string? = "text"
    t ??= throw Exception("missing")
    Console.WriteLine(t.Length)
}

main()`
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(source))
    }

    /// Review of #4980: in value position the right side runs before the
    /// write, so a reference receiver or CLR indexer key held in a variable is
    /// snapshotted; a right side that reassigns it does not redirect the write
    /// (C#: the target is evaluated once). A struct receiver keeps writing
    /// through its storage. The statement form is tracked separately in #5000.
    @Fact
    func ValuePosition_RhsReassigningReceiverOrKey_WritesTheOriginalTarget() {
        let source = `package Test
import System
import System.Collections.Generic

class Box {
    var F string?
}
struct S {
    var F string?
}

func main() {
    let first = Box{}
    let other = Box{}
    var box = first
    let r = (box.F ??= {
        box = other
        "v"
    })
    Console.WriteLine("${r} first=${first.F ?? "nil"} other=${other.F ?? "nil"}")
    let d = Dictionary[string, string?]()
    d["a"] = nil
    d["b"] = nil
    var key = "a"
    let r2 = (d[key] ??= {
        key = "b"
        "w"
    })
    Console.WriteLine("${r2} a=${d["a"] ?? "nil"} b=${d["b"] ?? "nil"}")
    var s = S{}
    let r3 = (s.F ??= "struct")
    Console.WriteLine("${r3} ${s.F ?? "nil"}")
}

main()`
        Assert.Equal(
            "v first=v other=nil${Environment.NewLine}w a=w b=nil${Environment.NewLine}struct struct${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func StructReceivers_InvalidArrayElement_ThrowsBeforeIndexerArguments(valuePosition bool, suspendingArgument bool) {
        let source = `package Test
import System
import System.Threading.Tasks
var calls = 0
func key() int32 {
    calls++
    return 0
}
async func delayedKey() int32 {
    await Task.Yield()
    return key()
}
async func run() {
    var a = []ArraySegment[string?]{ArraySegment[string?]([]string?{nil})}
    try {
        INVALID_ASSIGN
    } catch (ex IndexOutOfRangeException) {
        Console.WriteLine("bounds ${calls}")
    }
    VALID_ASSIGN
    Console.WriteLine("${a[0][0] ?? "nil"} ${calls}")
}
run().Wait()`.Replace(
            "INVALID_ASSIGN",
            if valuePosition {
                `let _ = (a[1][KEY()] ??= "lost")`
            } else {
                `a[1][KEY()] ??= "lost"`
            }
        ).Replace(
            "VALID_ASSIGN",
            if valuePosition {
                `let _ = (a[0][KEY()] ??= "v")`
            } else {
                `a[0][KEY()] ??= "v"`
            }
        ).Replace(
            "KEY()",
            if suspendingArgument {
                "await delayedKey()"
            } else {
                "key()"
            }
        )
        Assert.Equal("bounds 0${Environment.NewLine}v 1${Environment.NewLine}", CompileAndRun(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructReceivers_ArrayElementsAndNestedFields_KeepTheirStorage(valuePosition bool) {
        let source = `package Test
import System

struct S {
    var F string?
    var gets int32
    var sets int32
    prop P string? {
        get {
            gets++
            return F
        }
        set {
            sets++
            F = value
        }
    }
}
struct Outer {
    var Inner S
}
class Holder {
    var O Outer
}
var calls = 0
func index() int32 {
    calls++
    return 0
}
func main() {
    var a = []Outer{Outer{}}
    ARRAY_ASSIGN
    let h = Holder{}
    NESTED_ASSIGN
    var o = Outer{}
    LOCAL_ASSIGN
    PROPERTY_ASSIGN
    KEPT_ASSIGN
    Console.WriteLine("${a[0].Inner.F ?? "nil"} ${h.O.Inner.F ?? "nil"} ${o.Inner.F ?? "nil"} ${calls}")
    Console.WriteLine("${a[0].Inner.gets} ${a[0].Inner.sets} ${h.O.Inner.gets} ${h.O.Inner.sets}")
}
main()`.Replace(
            "ARRAY_ASSIGN",
            if valuePosition {
                `Console.WriteLine(a[index()].Inner.F ??= "array")`
            } else {
                `a[index()].Inner.F ??= "array"`
            }
        ).Replace(
            "NESTED_ASSIGN",
            if valuePosition {
                `Console.WriteLine(h.O.Inner.P ??= "nested")`
            } else {
                `h.O.Inner.P ??= "nested"`
            }
        ).Replace(
            "LOCAL_ASSIGN",
            if valuePosition {
                `Console.WriteLine(o.Inner.F ??= "local")`
            } else {
                `o.Inner.F ??= "local"`
            }
        ).Replace(
            "PROPERTY_ASSIGN",
            if valuePosition {
                `Console.WriteLine(a[index()].Inner.P ??= "lost")`
            } else {
                `a[index()].Inner.P ??= "lost"`
            }
        ).Replace(
            "KEPT_ASSIGN",
            if valuePosition {
                `Console.WriteLine(a[index()].Inner.F ??= "lost")`
            } else {
                `a[index()].Inner.F ??= "lost"`
            }
        )
        let values = if valuePosition {
            "array${Environment.NewLine}nested${Environment.NewLine}local${Environment.NewLine}array${Environment.NewLine}array${Environment.NewLine}"
        } else {
            ""
        }
        Assert.Equal(
            values + "array nested local 3${Environment.NewLine}1 0 1 1${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructReceivers_AwaitRhs_SnapshotsOwnersAndIndicesWithoutCopyingStorage(valuePosition bool) {
        let source = `package Test
import System
import System.Threading.Tasks

struct S {
    var F string?
    prop P string? {
        get {
            return F
        }
        set {
            F = value
        }
    }
}
struct Outer {
    var Inner S
}
class Holder {
    var O Outer
}
async func run() string {
    var a = []S{S{}, S{}}
    let first = a
    let other = []S{S{}, S{}}
    var i = 0
    ARRAY_ASSIGN
    var h = Holder{}
    let firstHolder = h
    let otherHolder = Holder{}
    NESTED_ASSIGN
    return "${first[0].F ?? "nil"} ${other[1].F ?? "nil"} ${firstHolder.O.Inner.F ?? "nil"} ${otherHolder.O.Inner.F ?? "nil"}"
}
func main() {
    Console.WriteLine(run().Result)
}
main()`.Replace(
            "ARRAY_ASSIGN",
            (
                if valuePosition {
                    "let _ = ("
                } else {
                    ""
                }
            ) +
                `a[i].F ??= {
        await Task.Yield()
        a = other
        i = 1
        "array"
    }` +
                (
                if valuePosition {
                    ")"
                } else {
                    ""
                }
            )
        )
            .Replace(
            "NESTED_ASSIGN",
            (
                if valuePosition {
                    "let _ = ("
                } else {
                    ""
                }
            ) +
                `h.O.Inner.P ??= {
        await Task.Yield()
        h = otherHolder
        "nested"
    }` +
                (
                if valuePosition {
                    ")"
                } else {
                    ""
                }
            )
        )
        Assert.Equal("array nil nested nil${Environment.NewLine}", CompileAndRun(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructReceivers_RefReturningCall_IsEvaluatedOnce(valuePosition bool) {
        let source = `package Test
import System
struct S {
    var F string?
}
var calls = 0
func pick(a []S) ref S {
    calls++
    return ref a[0]
}
func main() {
    var a = []S{S{}}
    ASSIGN
    Console.WriteLine("${a[0].F ?? "nil"} ${calls}")
}
main()`.Replace(
            "ASSIGN",
            if valuePosition {
                `Console.WriteLine(pick(a).F ??= "ref")`
            } else {
                `pick(a).F ??= "ref"`
            }
        )
        Assert.Equal(
            (
                if valuePosition {
                    "ref${Environment.NewLine}"
                } else {
                    ""
                }
            ) +
                "ref 1${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// Review of #4980: a target-less lambda whose body ends in `??=` infers
    /// `void`, as one ending in `=` does (issue #2152), in block and expression
    /// bodies, so it still passes as a `() -> void` callback. With a target
    /// type the lambda yields the value.
    @Fact
    func LambdaTail_InfersVoidLikeAssignment_UnlessTargetTyped() {
        let source = `package Test
import System

func run(cb () -> void) {
    cb()
}

func main() {
    var x string? = nil
    let fill = () -> {
        x ??= "block"
    }
    run(fill)
    var y string? = nil
    let fillExpr = () -> y ??= "expr"
    run(fillExpr)
    var z string? = nil
    let get () -> string = () -> z ??= "typed"
    var a string? = nil
    run(() -> {
        a ??= "direct"
    })
    var c string? = nil
    let f Func[string] = () -> c ??= "func"
    var d string? = nil
    let act Action = () -> d ??= "action"
    act()
    Console.WriteLine("${x} ${y} ${get()} ${a} ${f()} ${d}")
}

main()`
        Assert.Equal("block expr typed direct func action${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4967_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                // Drain both pipes concurrently and enforce the timeout before
                // collecting them, so a stalled sample fails instead of hanging.
                let stdoutTask = proc.StandardOutput.ReadToEndAsync()
                let stderrTask = proc.StandardError.ReadToEndAsync()
                if !proc.WaitForExit(30_000) {
                    try {
                        proc.Kill(entireProcessTree: true)
                    } catch (InvalidOperationException) { }
                    Assert.Fail("dotnet exec timed out")
                }
                let stdout = stdoutTask.GetAwaiter().GetResult()
                let stderr = stderrTask.GetAwaiter().GetResult()
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
