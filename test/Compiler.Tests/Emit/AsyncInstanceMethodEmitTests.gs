// <copyright file="AsyncInstanceMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Threading

/// Issue #502: `async func` declared as an instance (or shared/static) member
/// of a `class X { ... }` body parses, binds, and emits the same way
/// as a top-level `async func`. Each case asserts the call site sees a
/// `Task`/`Task<T>` return type, that the kickoff method
/// signature on the user type is `Task`-shaped, and that the assembly
/// runs end-to-end without an access-check failure on the synthesized
/// state-machine's `<>t__builder` field (the regression in #502).
open class AsyncInstanceMethodEmitTests {
    @Fact
    func Async_Instance_Method_Returning_Void_Becomes_Task_Returning_Method() {
        let source = `package P

import System.Threading.Tasks

class Greeter(Name string) {
    async func Greet() {
        await Task.Delay(1)
    }
}

public var result = ""
let g = Greeter("world")
let t = g.Greet()
t.Wait()
result = "ok"`
        let assembly = CompileToAssembly(source)
        let greeter = assembly.GetTypes().Single((t Type) -> t.Name == "Greeter")
        let greet MethodInfo? = greeter.GetMethod("Greet", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(greet)
        Assert.Equal(typeof(Task), greet!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("ok", cast[string](resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Async_Instance_Method_Returning_Int_Becomes_TaskOfInt() {
        let source = `package P

import System.Threading.Tasks

class Calc {
    init() {}

    async func Double(n int32) int32 {
        await Task.Delay(1)
        return n * 2
    }
}

public var result = 0
let c = Calc()
result = c.Double(21).Result`
        let assembly = CompileToAssembly(source)
        let calc = assembly.GetTypes().Single((t Type) -> t.Name == "Calc")
        let doubleMethod MethodInfo? = calc.GetMethod("Double", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(doubleMethod)
        Assert.Equal(typeof(Task[int32]), doubleMethod!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(42, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Async_Instance_Method_With_Multiple_Parameters_Round_Trips() {
        let source = `package P

import System.Threading.Tasks

class Calc {
    init() {}

    async func Add(a int32, b int32) int32 {
        await Task.Delay(1)
        return a + b
    }
}

public var result = 0
let c = Calc()
result = c.Add(7, 35).Result`
        let assembly = CompileToAssembly(source)
        let calc = assembly.GetTypes().Single((t Type) -> t.Name == "Calc")
        let add MethodInfo? = calc.GetMethod("Add", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(add)
        Assert.Equal(typeof(Task[int32]), add!!.ReturnType)
        Assert.Equal(2, add!!.GetParameters().Length)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(42, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Async_Instance_Method_With_Visibility_Modifier_Parses_And_Emits() {
        // The `public async func` shape is the exact form a port from C# would
        // produce. The accessibility look-ahead must allow `async` between the
        // accessibility modifier and `func`.
        let source = `package P

import System.Threading.Tasks

class Tagged {
    init() {}

    public async func Tag(n int32) int32 {
        await Task.Delay(1)
        return n + 100
    }
}

public var result = 0
let t = Tagged()
result = t.Tag(42).Result`
        let assembly = CompileToAssembly(source)
        let tagged = assembly.GetTypes().Single((t Type) -> t.Name == "Tagged")
        let tag MethodInfo? = tagged.GetMethod("Tag", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(tag)
        Assert.Equal(typeof(Task[int32]), tag!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(142, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Async_Instance_Method_Captures_Receiver_Field_Through_State_Machine() {
        // The kickoff hoists `this` into the state machine, so the awaited
        // continuation must read the primary-ctor field `Base` from the
        // captured receiver, not from a stale stack slot.
        let source = `package P

import System.Threading.Tasks

class Adder(Base int32) {
    async func Bump(n int32) int32 {
        await Task.Delay(1)
        return Base + n
    }
}

public var result = 0
let a = Adder(40)
result = a.Bump(2).Result`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(42, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Async_Shared_Method_Becomes_Task_Returning_Static_Method() {
        // ADR-0053 shared (static) member: `async func` inside `shared { }`
        // mirrors the instance-method path.
        let source = `package P

import System.Threading.Tasks

class Math2 {
    shared {
        async func Triple(n int32) int32 {
            await Task.Delay(1)
            return n * 3
        }
    }
}

public var result = 0
result = Math2.Triple(14).Result`
        let assembly = CompileToAssembly(source)
        let math2 = assembly.GetTypes().Single((t Type) -> t.Name == "Math2")
        let triple MethodInfo? = math2.GetMethod("Triple", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(triple)
        Assert.Equal(typeof(Task[int32]), triple!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(42, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func State_Machine_Type_Is_Nested_Inside_Declaring_User_Class() {
        // Issue #502 regression: an instance-method state machine nested
        // inside the per-package `<Program>` causes the kickoff method on
        // the user class to trip a FieldAccessException when it touches the
        // SM's NestedPrivate `<>t__builder` field. Confirm the SM type now
        // nests inside its declaring class so the kickoff retains access.
        let source = `package P

import System.Threading.Tasks

class Box {
    init() {}

    async func Inc(n int32) int32 {
        await Task.Delay(1)
        return n + 1
    }
}`
        let assembly = CompileToAssembly(source)
        let box = assembly.GetTypes().Single((t Type) -> t.Name == "Box")
        let nested = box.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic)
        Assert.Contains(nested, (t Type) -> t.Name.Contains("Inc") && t.Name.Contains("d__"))
    }

    // Issue #502 follow-up (sub-bug 502-a): an `async func ... T { ... }`
    // declared as an instance member must lift the call-site type to Task[T]
    // not just at the top-level call site, but also when the call is awaited
    // from inside another async member of the same class. The previous fix
    // wrapped the call's static type in `BindUserInstanceCall`; this test
    // exercises the lowering path that re-builds the call node when the
    // implicit `this` receiver is replaced (e.g. by the state-machine
    // rewriter's hoisted-`<>4__this`). If the call-type override is dropped
    // there, the receiver of the subsequent `GetAwaiter()` is mis-typed and
    // the program either crashes or hangs.
    @Fact
    func Async_Instance_Method_Returning_Int_Is_Awaitable_From_Sibling_Member() {
        let source = `package P

import System.Threading.Tasks

class Probe {
    init() {}

    async func ReturnInt() int32 {
        await Task.Delay(1)
        return 42
    }

    async func CallIt() int32 {
        var r = await ReturnInt()
        return r
    }
}

public var result = 0
let p = Probe()
result = p.CallIt().Result`
        let assembly = CompileToAssembly(source)
        let probe = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let returnInt MethodInfo? = probe.GetMethod("ReturnInt", BindingFlags.Public | BindingFlags.Instance)
        let callIt MethodInfo? = probe.GetMethod("CallIt", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(returnInt)
        Assert.NotNull(callIt)
        // Both members must be lifted to Task[int].
        Assert.Equal(typeof(Task[int32]), returnInt!!.ReturnType)
        Assert.Equal(typeof(Task[int32]), callIt!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        // Bound a hard timeout around the entry-point so a regression of
        // bug 502-b (the awaited inner async member never resolving) fails
        // the test loudly rather than hanging the test host.
        InvokeWithHangGuard(entry!!)
        Assert.Equal(42, int32(resultField!!.GetValue(nil)!!))
    }

    // Issue #502 follow-up (sub-bug 502-b): a void-returning `async func`
    // class member must lift to `Task` and the returned Task must actually
    // complete when the body awaits another async member. Without the fix,
    // the call from one async member to another mis-typed the awaited
    // receiver, the inner Task never visibly completed from the caller's
    // perspective, and `Task.Wait()` deadlocked. We assert end-to-end
    // execution under a short timeout to detect any future hang regression.
    @Fact
    func Void_Async_Instance_Method_Awaiting_Sibling_Returns_Completed_Task() {
        let source = `package P

import System.Threading.Tasks

class Probe {
    init() {}

    async func Inner() int32 {
        await Task.Delay(1)
        return 7
    }

    async func Outer() {
        var v = await Inner()
        captured = v
    }
}

public var captured = 0
let p = Probe()
let t = p.Outer()
t.Wait()`
        let assembly = CompileToAssembly(source)
        let probe = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let outerMethod MethodInfo? = probe.GetMethod("Outer", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(outerMethod)
        // Void-returning async member should lift to non-generic Task.
        Assert.Equal(typeof(Task), outerMethod!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let capturedField FieldInfo? = program.GetField("captured", BindingFlags.Public | BindingFlags.Static)
        InvokeWithHangGuard(entry!!)
        Assert.Equal(7, int32(capturedField!!.GetValue(nil)!!))
    }

    // The originally-reported parse repro from issue #502: an annotated
    // `async func` class member should parse and bind clean, with the
    // emitted kickoff method returning a `Task` (no value channel).
    @Fact
    func Annotated_Async_Instance_Member_With_No_Return_Lifts_To_Task() {
        let source = `package P

import System.Threading.Tasks

class SmokeTests {
    init() {}

    @Obsolete
    async func DoIt() {
        await Task.Delay(1)
    }
}

public var ok = false
let t = SmokeTests()
t.DoIt().Wait()
ok = true`
        let assembly = CompileToAssembly(source)
        let smoke = assembly.GetTypes().Single((t Type) -> t.Name == "SmokeTests")
        let doIt MethodInfo? = smoke.GetMethod("DoIt", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(doIt)
        Assert.Equal(typeof(Task), doIt!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let okField FieldInfo? = program.GetField("ok", BindingFlags.Public | BindingFlags.Static)
        InvokeWithHangGuard(entry!!)
        Assert.True(bool(okField!!.GetValue(nil)!!))
    }

    // Combined coverage: an async member chains through an explicit
    // `this.Other()` receiver, exercising the same lowering path as the
    // implicit-`this` form but with the call's receiver materialized
    // up-front in binding.
    @Fact
    func Async_Instance_Method_Awaits_Sibling_Through_Explicit_This_Receiver() {
        let source = `package P

import System.Threading.Tasks

class Chain {
    init() {}

    async func Add1(n int32) int32 {
        await Task.Delay(1)
        return n + 1
    }

    async func Add3(n int32) int32 {
        var a = await this.Add1(n)
        var b = await this.Add1(a)
        var c = await this.Add1(b)
        return c
    }
}

public var result = 0
let c = Chain()
result = c.Add3(10).Result`
        let assembly = CompileToAssembly(source)
        let chain = assembly.GetTypes().Single((t Type) -> t.Name == "Chain")
        let add3 MethodInfo? = chain.GetMethod("Add3", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(add3)
        Assert.Equal(typeof(Task[int32]), add3!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        InvokeWithHangGuard(entry!!)
        Assert.Equal(13, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Async_Instance_Method_Returning_User_Class_Is_Awaitable() {
        let source = `package P

import System
import System.Threading.Tasks

class AsyncPC(Value int32) {}

class Probe {
    async func MakePC() AsyncPC {
        await Task.Delay(1)
        return AsyncPC(7)
    }

    async func Pc_Roundtrip() {
        let r = await this.MakePC()
        Console.WriteLine(r.Value)
    }
}

let p = Probe()
p.Pc_Roundtrip().Wait()`
        let assembly = CompileToAssembly(source)
        let probe = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let asyncPc = assembly.GetTypes().Single((t Type) -> t.Name == "AsyncPC")
        let makePc MethodInfo? = probe.GetMethod("MakePC", BindingFlags.Public | BindingFlags.Instance)
        let roundtrip MethodInfo? = probe.GetMethod("Pc_Roundtrip", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(makePc)
        Assert.NotNull(roundtrip)
        Assert.Equal(typeof(Task[_]).MakeGenericType(asyncPc), makePc!!.ReturnType)
        Assert.Equal(typeof(Task), roundtrip!!.ReturnType)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        InvokeWithHangGuard(entry!!)
    }

    shared {
        // Issue #502 hang-guard: invoke the compiled entry on a worker thread
        // with a hard timeout. A hang in async lowering would otherwise deadlock
        // the test host until xunit's per-collection timeout (or worse, never).
        private func InvokeWithHangGuard(entry MethodInfo?, timeoutMs int32 = 5000) {
            var captured Exception? = nil
            let thread = Thread(
                () -> {
                    try {
                        entry!!.Invoke(
                            nil,
                            if entry!!.GetParameters().Length == 0 {
                                default([]?object)
                            } else {
                                []object{Array.Empty[string]()}
                            }
                        )
                    } catch (ex Exception) {
                        captured = ex
                    }
                }
            )
            thread.IsBackground = true
            thread.Start()
            let finished = thread.Join(timeoutMs)
            Assert.True(
                finished,
                "Compiled entry-point did not complete within " + timeoutMs.ToString() +
                    " ms — async lowering hang (bug #502 sub-bug 502-b regression)."
            )
            if captured != nil {
                throw InvalidOperationException("Compiled entry-point threw.", captured)
            }
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_async_instance_emit_").FullName
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
            return EmittedFixture.Load(outPath)
        }
    }
}
