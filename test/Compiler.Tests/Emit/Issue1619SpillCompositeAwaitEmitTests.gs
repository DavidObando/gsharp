// <copyright file="Issue1619SpillCompositeAwaitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #1619: `SpillSequenceSpiller` treated ~40 composite expression
/// kinds (ternary, index, CLR static/ctor calls, array/tuple/struct/map
/// literals, switch expressions, and more) as await-free leaves, returning
/// them unchanged via `Trivial(...)`. Any await nested inside one of
/// these leaked past the spiller to the emitter, which threw a mislocated
/// `GS9998` ICE at (1,1). The fix gives each mechanical composite kind a
/// real spill path (mirroring `SpillCall`/`SpillBinary`), and the
/// ternary, switch expression, null-conditional access, and conditional
/// address-of a genuine if/else control-flow expansion so only the taken
/// branch's await actually runs. The one remaining diagnostic-gated shape is
/// an `await` inside a switch-expression `when` guard (see
/// `SpillSwitch` in `SpillSequenceSpiller.cs` for why that specific
/// shape cannot be mechanically spilled without duplicating the whole
/// pattern-matching decision tree).
///
/// Each test here compiles the offending shape, IL-verifies the emitted
/// assembly, runs it, and asserts the correct result.
open class Issue1619SpillCompositeAwaitEmitTests {
    @Fact
    func Await_In_Ternary_Arm_Evaluates_Only_Taken_Branch() {
        let source = `package P1619A

import System.Threading.Tasks

public var trueRuns = 0
public var falseRuns = 0

func trueTask() Task[int32] {
    trueRuns = trueRuns + 1
    return Task.FromResult(11)
}

func falseTask() Task[int32] {
    falseRuns = falseRuns + 1
    return Task.FromResult(22)
}

class C {
    init() {}

    async func Pick(flag bool) int32 {
        let x = flag ? await trueTask() : await falseTask()
        return x
    }
}

public var whenTrue = -1
public var whenFalse = -1
let c = C()
whenTrue = c.Pick(true).Result
whenFalse = c.Pick(false).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(11, ReadInt(program, "whenTrue"))
        Assert.Equal(22, ReadInt(program, "whenFalse"))
        // Each branch's await must only run when that branch is taken.
        Assert.Equal(1, ReadInt(program, "trueRuns"))
        Assert.Equal(1, ReadInt(program, "falseRuns"))
    }

    @Fact
    func Await_In_Ternary_With_NonAwait_Arm_Only_Runs_TakenBranch() {
        let source = `package P1619B

import System.Threading.Tasks

class C {
    init() {}

    async func Pick(flag bool, t Task[int32]) int32 {
        let x = flag ? await t : 0
        return x
    }
}

public var whenTrue = -1
public var whenFalse = -1
let c = C()
whenTrue = c.Pick(true, Task.FromResult(7)).Result
whenFalse = c.Pick(false, Task.FromResult(999)).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(7, ReadInt(program, "whenTrue"))
        Assert.Equal(0, ReadInt(program, "whenFalse"))
    }

    @Fact
    func Await_In_Index_Expression_Evaluates_Correct_Element() {
        let source = `package P1619C

import System.Threading.Tasks

class C {
    init() {}

    async func Get(arr []int32, idx Task[int32]) int32 {
        return arr[await idx]
    }
}

public var result = -1
let c = C()
let arr = []int32{100, 200, 300}
result = c.Get(arr, Task.FromResult(2)).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(300, ReadInt(program, "result"))
    }

    @Fact
    func Await_In_Clr_Static_Call_Argument_Preserves_Order() {
        let source = `package P1619D

import System.Threading.Tasks

public var order = ""

func first() Task[int32] {
    order = order + "1"
    return Task.FromResult(3)
}

class C {
    init() {}

    async func MaxWithAwait() int32 {
        return System.Math.Max(await first(), 5)
    }
}

public var result = -1
let c = C()
result = c.MaxWithAwait().Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(5, ReadInt(program, "result"))
    }

    @Fact
    func Await_In_Array_Literal_Element_Preserves_Order_And_Values() {
        let source = `package P1619E

import System.Threading.Tasks

class C {
    init() {}

    async func Build(a Task[int32], b int32) []int32 {
        let arr = []int32{await a, b, 30}
        return arr
    }
}

public var e0 = -1
public var e1 = -1
public var e2 = -1
let c = C()
let arr = c.Build(Task.FromResult(10), 20).Result
e0 = arr[0]
e1 = arr[1]
e2 = arr[2]`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(10, ReadInt(program, "e0"))
        Assert.Equal(20, ReadInt(program, "e1"))
        Assert.Equal(30, ReadInt(program, "e2"))
    }

    @Fact
    func Await_In_Tuple_Literal_Element_Preserves_Values() {
        let source = `package P1619F

import System.Threading.Tasks

class C {
    init() {}

    async func Build(a Task[int32]) (int32, int32) {
        let t (int32, int32) = (await a, 42)
        return t
    }
}

public var first = -1
public var second = -1
let c = C()
let t = c.Build(Task.FromResult(9)).Result
first = t.Item1
second = t.Item2`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(9, ReadInt(program, "first"))
        Assert.Equal(42, ReadInt(program, "second"))
    }

    @Fact
    func Await_In_Switch_Expression_Arm_Runs_Only_Selected_Arm() {
        let source = `package P1619G

import System.Threading.Tasks

public var oneRuns = 0
public var defaultRuns = 0

func oneTask() Task[int32] {
    oneRuns = oneRuns + 1
    return Task.FromResult(111)
}

class C {
    init() {}

    async func Pick(n int32, t Task[int32]) int32 {
        let x = switch n {
            case 1: await t
            default: 999 + defaultRuns
        }
        return x
    }
}

public var whenOne = -1
public var whenDefault = -1
let c = C()
whenOne = c.Pick(1, oneTask()).Result
defaultRuns = defaultRuns + 1
whenDefault = c.Pick(2, Task.FromResult(0)).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(111, ReadInt(program, "whenOne"))
        Assert.Equal(1000, ReadInt(program, "whenDefault"))
        Assert.Equal(1, ReadInt(program, "oneRuns"))
    }

    @Fact
    func Await_In_Switch_Expression_Governing_Expression_Selects_Correct_Arm() {
        let source = `package P1619H

import System.Threading.Tasks

class C {
    init() {}

    async func Pick(nTask Task[int32]) int32 {
        let x = switch await nTask {
            case 1: 100
            case 2: 200
            default: -1
        }
        return x
    }
}

public var result1 = -1
public var result2 = -1
let c = C()
result1 = c.Pick(Task.FromResult(1)).Result
result2 = c.Pick(Task.FromResult(2)).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(100, ReadInt(program, "result1"))
        Assert.Equal(200, ReadInt(program, "result2"))
    }

    @Fact
    func Await_In_Switch_Expression_Arm_Survives_Real_Suspension() {
        // Task.Yield() forces an actual suspend/resume through
        // AwaitUnsafeOnCompleted (not the Task.FromResult fast path), so this
        // also exercises the arm-index/result spill temps across a genuine
        // state-machine re-entry.
        let source = `package P1619I

import System.Threading.Tasks

async func yieldThenGet() int32 {
    await Task.Yield()
    return 42
}

class C {
    init() {}

    async func Pick(n int32) int32 {
        let x = switch n {
            case 1: await yieldThenGet()
            default: -1
        }
        return x
    }
}

public var result = -1
let c = C()
result = c.Pick(1).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(42, ReadInt(program, "result"))
    }

    @Fact
    func Await_Inside_Switch_Expression_Guard_Reports_Anchored_Diagnostic_Not_ICE() {
        // A `when`-guard containing await is the one shape this pass still
        // cannot mechanically spill: a false guard must fall through to the
        // next arm's pattern test, which would require re-implementing the
        // whole pattern-match decision tree as bound-tree control flow rather
        // than reusing the existing emitter's pattern dispatch.
        let source = `package P1619J

import System.Threading.Tasks

class C {
    init() {}

    async func Pick(n int32, t Task[bool]) int32 {
        let x = switch n {
            case 1 when await t: 10
            default: 0
        }
        return x
    }
}`
        let (compileExit, stdout, stderr) = TryCompile(source)
        Assert.NotEqual(0, compileExit)
        let combined = stdout + stderr
        Assert.Contains("GS9998", combined)
        Assert.Contains("'await' inside a switch-expression 'when' guard is not yet supported", combined)
    }

    @Fact
    func Await_In_NullConditional_Access_Argument_Nil_And_NonNil() {
        let source = `package P1619K

import System.Threading.Tasks

class Box {
    init(v int32) { this.v = v }
    var v int32
    func Add(n int32) int32 { return this.v + n }
}

class C {
    init() {}

    async func AddToBox(b Box?, t Task[int32]) int32? {
        return b?.Add(await t)
    }
}

public var nonNilResult = -1
public var nilIsNil = 0
let c = C()
let box = Box(10)
let r1 = c.AddToBox(box, Task.FromResult(5)).Result
nonNilResult = r1 ?? -100
let r2 = c.AddToBox(nil, Task.FromResult(999)).Result
nilIsNil = (r2 == nil) ? 1 : 0`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(15, ReadInt(program, "nonNilResult"))
        Assert.Equal(1, ReadInt(program, "nilIsNil"))
    }

    @Fact
    func Await_In_NullConditional_Receiver_Evaluates_Chain() {
        let source = `package P1619L

import System.Threading.Tasks

class C {
    init() {}

    async func GetLength(t Task[string?]) int32? {
        return (await t)?.Length
    }
}

public var nonNilLen = -1
public var nilIsNil = 0
let c = C()
let r1 = c.GetLength(Task.FromResult[string?]("hello")).Result
nonNilLen = r1 ?? -100
let r2 = c.GetLength(Task.FromResult[string?](nil)).Result
nilIsNil = (r2 == nil) ? 1 : 0`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(5, ReadInt(program, "nonNilLen"))
        Assert.Equal(1, ReadInt(program, "nilIsNil"))
    }

    @Fact
    func Await_In_Conditional_Address_Condition_Selects_Correct_RefBranch() {
        let source = `package P1619M

import System.Threading.Tasks

func bump(ref counter int32) {
    counter = counter + 1
}

class C {
    init() {}

    async func BumpPicked(useA Task[bool], a int32, b int32) (int32, int32) {
        var aa = a
        var bb = b
        bump(ref (await useA) ? aa : bb)
        return (aa, bb)
    }
}

public var aWhenTrue = -1
public var bWhenTrue = -1
public var aWhenFalse = -1
public var bWhenFalse = -1
let c = C()
let r1 = c.BumpPicked(Task.FromResult(true), 10, 20).Result
aWhenTrue = r1.Item1
bWhenTrue = r1.Item2
let r2 = c.BumpPicked(Task.FromResult(false), 10, 20).Result
aWhenFalse = r2.Item1
bWhenFalse = r2.Item2`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(11, ReadInt(program, "aWhenTrue"))
        Assert.Equal(20, ReadInt(program, "bWhenTrue"))
        Assert.Equal(10, ReadInt(program, "aWhenFalse"))
        Assert.Equal(21, ReadInt(program, "bWhenFalse"))
    }

    @Fact
    func Await_In_Conditional_Address_Arm_Evaluates_NonAwaiting_Condition_Exactly_Once() {
        // Regression for the double/triple-eval defect: when the condition
        // itself has no await but one of the arms does, the condition used
        // to be re-emitted once per guard plus once more in the rebuilt
        // BoundConditionalAddressExpression - up to 2-3 evaluations of a
        // side-effectful condition instead of exactly 1.
        let source = `package P1619N

import System.Threading.Tasks

public var pickCount = 0

func pick() bool {
    pickCount = pickCount + 1
    return true
}

func bump(ref counter int32) {
    counter = counter + 1
}

class CondPicker {
    init() {}

    async func BumpPicked(arr []int32, idxTask Task[int32]) []int32 {
        bump(ref pick() ? arr[await idxTask] : arr[2])
        return arr
    }
}

public var elem0 = -1
public var elem2 = -1
let c = CondPicker()
let arr = []int32{10, 20, 30}
let r = c.BumpPicked(arr, Task.FromResult(0)).Result
elem0 = r[0]
elem2 = r[2]`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        // pick() always selects the true branch (arr[await idxTask] with
        // idxTask == 0), so only element 0 is bumped, and pick()'s side
        // effect must run exactly once regardless of how many branches
        // reference the condition during spilling.
        Assert.Equal(11, ReadInt(program, "elem0"))
        Assert.Equal(30, ReadInt(program, "elem2"))
        Assert.Equal(1, ReadInt(program, "pickCount"))
    }

    @Fact
    func Await_In_NullConditional_Access_On_ValueType_Nullable_Runs_And_Verifies() {
        // Issue #1700: T? for a value type (struct) receiver, with an await
        // inside the null-conditional invocation's argument. The receiver
        // probe (EmitNullConditionalReceiverProbe) now spills the value-type
        // Nullable<T> receiver to its own scratch slot and boxes it (rather
        // than storing it into nc.Capture, which is declared as the
        // unwrapped T and previously produced a StackUnexpected verifier
        // error), matching the `??`/`!!` null-probe shapes elsewhere in the
        // emitter, so this now emits valid IL and runs both the has-value
        // and nil receiver shapes correctly.
        let source = `package P1700A

import System.Threading.Tasks

struct Pt {
    var X int32
    func Add(n int32) int32 { return this.X + n }
}

class C {
    init() {}

    async func AddToPoint(p Pt?, t Task[int32]) int32? {
        return p?.Add(await t)
    }
}

public var nonNilResult = -1
public var nilResult = -1
let c = C()
let p = Pt{X: 10}
let r1 = c.AddToPoint(p, Task.FromResult(5)).Result
nonNilResult = r1 ?? -100
let r2 = c.AddToPoint(nil, Task.FromResult(5)).Result
nilResult = r2 ?? -100`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(15, ReadInt(program, "nonNilResult"))
        Assert.Equal(-100, ReadInt(program, "nilResult"))
    }

    @Fact
    func Await_In_NullConditional_Receiver_On_Bcl_ValueType_Nullable_Runs_And_Verifies() {
        // Issue #1700 sibling shape: the await sits in the *receiver*
        // expression (SpillNullConditionalAccess's receiverHasAwait branch,
        // rebuilding the node with the possibly-spilled receiver expression
        // unchanged) rather than in the invocation argument (the
        // receiverHasAwait == false, whenNotNullHasAwait == true branch
        // exercised above). Uses a BCL value type (int32?) to prove the fix
        // generalizes beyond user-declared structs. Both branches funnel
        // through the same EmitNullConditionalReceiverProbe fix.
        let source = `package P1700C

import System.Threading.Tasks

class C2 {
    init() {}

    async func Cmp(t Task[int32?]) int32? {
        return (await t)?.CompareTo(5)
    }
}

public var nonNilResult = -100
public var nilResult = -100
let c = C2()
let r1 = c.Cmp(Task.FromResult[int32?](10)).Result
nonNilResult = r1 ?? -100
let r2 = c.Cmp(Task.FromResult[int32?](nil)).Result
nilResult = r2 ?? -100`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(1, ReadInt(program, "nonNilResult"))
        Assert.Equal(-100, ReadInt(program, "nilResult"))
    }

    @Fact
    func Await_In_Switch_Expression_Without_Default_Is_Rejected_At_Compile_Time() {
        // Watch-item: a non-exhaustive switch expression (no default/missing
        // match) that silently executes arm 0 instead of throwing. This
        // cannot be constructed in G#: the binder requires every switch
        // *expression* to have a 'default' arm (GS0176) regardless of
        // whether await appears inside it, so there is no bound tree shape
        // for SpillSwitch to mis-lower here - the language's exhaustiveness
        // rule, not the spiller, is what prevents the "no-match silently
        // runs arm 0" failure mode.
        let source = `package P1619P

import System.Threading.Tasks

class C {
    init() {}

    async func Pick(n int32, t Task[int32]) int32 {
        let x = switch n {
            case 1: await t
        }
        return x
    }
}`
        let (compileExit, stdout, stderr) = TryCompile(source)
        Assert.NotEqual(0, compileExit)
        Assert.Contains("GS0176", stdout + stderr)
    }

    shared {
        private func ReadInt(program Type, fieldName string) int32 {
            let field FieldInfo? = program.GetField(
                fieldName,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(field)
            return int32(field!!.GetValue(nil)!!)
        }

        private func TryCompile(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1619_spill_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (compileExit, compileOut.ToString(), compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndInvokeEntry(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_1619_spill_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let assembly = EmittedFixture.Load(outPath)
                let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
                let entry MethodInfo? = program.GetMethod(
                    "<Main>$$",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                Assert.NotNull(entry)
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
                return assembly
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
