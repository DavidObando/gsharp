// <copyright file="AsyncInstanceMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #502: `async func` declared as an instance (or shared/static) member
/// of a <c>type X class { ... }</c> body parses, binds, and emits the same way
/// as a top-level <c>async func</c>. Each case asserts the call site sees a
/// <c>Task</c>/<c>Task&lt;T&gt;</c> return type, that the kickoff method
/// signature on the user type is <c>Task</c>-shaped, and that the assembly
/// runs end-to-end without an access-check failure on the synthesized
/// state-machine's <c>&lt;&gt;t__builder</c> field (the regression in #502).
/// </summary>
public class AsyncInstanceMethodEmitTests
{
    [Fact]
    public void Async_Instance_Method_Returning_Void_Becomes_Task_Returning_Method()
    {
        var source = """
            package P

            import System.Threading.Tasks

            type Greeter class(Name string) {
                async func Greet() {
                    await Task.Delay(1)
                }
            }

            public var result = ""
            let g = Greeter("world")
            let t = g.Greet()
            t.Wait()
            result = "ok"
            """;

        var assembly = CompileToAssembly(source);
        var greeter = assembly.GetTypes().Single(t => t.Name == "Greeter");
        var greet = greeter.GetMethod("Greet", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(greet);
        Assert.Equal(typeof(Task), greet!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        Assert.Equal("ok", (string)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Async_Instance_Method_Returning_Int_Becomes_TaskOfInt()
    {
        var source = """
            package P

            import System.Threading.Tasks

            type Calc class {
                init() {}

                async func Double(n int32) int32 {
                    await Task.Delay(1)
                    return n * 2
                }
            }

            public var result = 0
            let c = Calc()
            result = c.Double(21).Result
            """;

        var assembly = CompileToAssembly(source);
        var calc = assembly.GetTypes().Single(t => t.Name == "Calc");
        var doubleMethod = calc.GetMethod("Double", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(doubleMethod);
        Assert.Equal(typeof(Task<int>), doubleMethod!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        Assert.Equal(42, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Async_Instance_Method_With_Multiple_Parameters_Round_Trips()
    {
        var source = """
            package P

            import System.Threading.Tasks

            type Calc class {
                init() {}

                async func Add(a int32, b int32) int32 {
                    await Task.Delay(1)
                    return a + b
                }
            }

            public var result = 0
            let c = Calc()
            result = c.Add(7, 35).Result
            """;

        var assembly = CompileToAssembly(source);
        var calc = assembly.GetTypes().Single(t => t.Name == "Calc");
        var add = calc.GetMethod("Add", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(add);
        Assert.Equal(typeof(Task<int>), add!.ReturnType);
        Assert.Equal(2, add.GetParameters().Length);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        Assert.Equal(42, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Async_Instance_Method_With_Visibility_Modifier_Parses_And_Emits()
    {
        // The `public async func` shape is the exact form a port from C# would
        // produce. The accessibility look-ahead must allow `async` between the
        // accessibility modifier and `func`.
        var source = """
            package P

            import System.Threading.Tasks

            type Tagged class {
                init() {}

                public async func Tag(n int32) int32 {
                    await Task.Delay(1)
                    return n + 100
                }
            }

            public var result = 0
            let t = Tagged()
            result = t.Tag(42).Result
            """;

        var assembly = CompileToAssembly(source);
        var tagged = assembly.GetTypes().Single(t => t.Name == "Tagged");
        var tag = tagged.GetMethod("Tag", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(tag);
        Assert.Equal(typeof(Task<int>), tag!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        Assert.Equal(142, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Async_Instance_Method_Captures_Receiver_Field_Through_State_Machine()
    {
        // The kickoff hoists `this` into the state machine, so the awaited
        // continuation must read the primary-ctor field `Base` from the
        // captured receiver, not from a stale stack slot.
        var source = """
            package P

            import System.Threading.Tasks

            type Adder class(Base int32) {
                async func Bump(n int32) int32 {
                    await Task.Delay(1)
                    return Base + n
                }
            }

            public var result = 0
            let a = Adder(40)
            result = a.Bump(2).Result
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        Assert.Equal(42, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Async_Shared_Method_Becomes_Task_Returning_Static_Method()
    {
        // ADR-0053 shared (static) member: `async func` inside `shared { }`
        // mirrors the instance-method path.
        var source = """
            package P

            import System.Threading.Tasks

            type Math2 class {
                shared {
                    async func Triple(n int32) int32 {
                        await Task.Delay(1)
                        return n * 3
                    }
                }
            }

            public var result = 0
            result = Math2.Triple(14).Result
            """;

        var assembly = CompileToAssembly(source);
        var math2 = assembly.GetTypes().Single(t => t.Name == "Math2");
        var triple = math2.GetMethod("Triple", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(triple);
        Assert.Equal(typeof(Task<int>), triple!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        Assert.Equal(42, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void State_Machine_Type_Is_Nested_Inside_Declaring_User_Class()
    {
        // Issue #502 regression: an instance-method state machine nested
        // inside the per-package `<Program>` causes the kickoff method on
        // the user class to trip a FieldAccessException when it touches the
        // SM's NestedPrivate `<>t__builder` field. Confirm the SM type now
        // nests inside its declaring class so the kickoff retains access.
        var source = """
            package P

            import System.Threading.Tasks

            type Box class {
                init() {}

                async func Inc(n int32) int32 {
                    await Task.Delay(1)
                    return n + 1
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var box = assembly.GetTypes().Single(t => t.Name == "Box");

        var nested = box.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic);
        Assert.Contains(nested, t => t.Name.Contains("Inc") && t.Name.Contains("d__"));
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
    [Fact]
    public void Async_Instance_Method_Returning_Int_Is_Awaitable_From_Sibling_Member()
    {
        var source = """
            package P

            import System.Threading.Tasks

            type Probe class {
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
            result = p.CallIt().Result
            """;

        var assembly = CompileToAssembly(source);
        var probe = assembly.GetTypes().Single(t => t.Name == "Probe");
        var returnInt = probe.GetMethod("ReturnInt", BindingFlags.Public | BindingFlags.Instance);
        var callIt = probe.GetMethod("CallIt", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(returnInt);
        Assert.NotNull(callIt);

        // Both members must be lifted to Task[int].
        Assert.Equal(typeof(Task<int>), returnInt!.ReturnType);
        Assert.Equal(typeof(Task<int>), callIt!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        // Bound a hard timeout around the entry-point so a regression of
        // bug 502-b (the awaited inner async member never resolving) fails
        // the test loudly rather than hanging the test host.
        InvokeWithHangGuard(entry!);
        Assert.Equal(42, (int)resultField!.GetValue(null)!);
    }

    // Issue #502 follow-up (sub-bug 502-b): a void-returning `async func`
    // class member must lift to `Task` and the returned Task must actually
    // complete when the body awaits another async member. Without the fix,
    // the call from one async member to another mis-typed the awaited
    // receiver, the inner Task never visibly completed from the caller's
    // perspective, and `Task.Wait()` deadlocked. We assert end-to-end
    // execution under a short timeout to detect any future hang regression.
    [Fact]
    public void Void_Async_Instance_Method_Awaiting_Sibling_Returns_Completed_Task()
    {
        var source = """
            package P

            import System.Threading.Tasks

            type Probe class {
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
            t.Wait()
            """;

        var assembly = CompileToAssembly(source);
        var probe = assembly.GetTypes().Single(t => t.Name == "Probe");
        var outerMethod = probe.GetMethod("Outer", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(outerMethod);

        // Void-returning async member should lift to non-generic Task.
        Assert.Equal(typeof(Task), outerMethod!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var capturedField = program.GetField("captured", BindingFlags.Public | BindingFlags.Static);

        InvokeWithHangGuard(entry!);
        Assert.Equal(7, (int)capturedField!.GetValue(null)!);
    }

    // The originally-reported parse repro from issue #502: an annotated
    // `async func` class member should parse and bind clean, with the
    // emitted kickoff method returning a `Task` (no value channel).
    [Fact]
    public void Annotated_Async_Instance_Member_With_No_Return_Lifts_To_Task()
    {
        var source = """
            package P

            import System.Threading.Tasks

            type SmokeTests class {
                init() {}

                @Obsolete
                async func DoIt() {
                    await Task.Delay(1)
                }
            }

            public var ok = false
            let t = SmokeTests()
            t.DoIt().Wait()
            ok = true
            """;

        var assembly = CompileToAssembly(source);
        var smoke = assembly.GetTypes().Single(t => t.Name == "SmokeTests");
        var doIt = smoke.GetMethod("DoIt", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(doIt);
        Assert.Equal(typeof(Task), doIt!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var okField = program.GetField("ok", BindingFlags.Public | BindingFlags.Static);

        InvokeWithHangGuard(entry!);
        Assert.True((bool)okField!.GetValue(null)!);
    }

    // Combined coverage: an async member chains through an explicit
    // `this.Other()` receiver, exercising the same lowering path as the
    // implicit-`this` form but with the call's receiver materialized
    // up-front in binding.
    [Fact]
    public void Async_Instance_Method_Awaits_Sibling_Through_Explicit_This_Receiver()
    {
        var source = """
            package P

            import System.Threading.Tasks

            type Chain class {
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
            result = c.Add3(10).Result
            """;

        var assembly = CompileToAssembly(source);
        var chain = assembly.GetTypes().Single(t => t.Name == "Chain");
        var add3 = chain.GetMethod("Add3", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(add3);
        Assert.Equal(typeof(Task<int>), add3!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        InvokeWithHangGuard(entry!);
        Assert.Equal(13, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Async_Instance_Method_Returning_User_Class_Is_Awaitable()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            type AsyncPC class(Value int32) {}

            type Probe class {
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
            p.Pc_Roundtrip().Wait()
            """;

        var assembly = CompileToAssembly(source);
        var probe = assembly.GetTypes().Single(t => t.Name == "Probe");
        var asyncPc = assembly.GetTypes().Single(t => t.Name == "AsyncPC");
        var makePc = probe.GetMethod("MakePC", BindingFlags.Public | BindingFlags.Instance);
        var roundtrip = probe.GetMethod("Pc_Roundtrip", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(makePc);
        Assert.NotNull(roundtrip);
        Assert.Equal(typeof(Task<>).MakeGenericType(asyncPc), makePc!.ReturnType);
        Assert.Equal(typeof(Task), roundtrip!.ReturnType);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        InvokeWithHangGuard(entry!);
    }

    // Issue #502 hang-guard: invoke the compiled entry on a worker thread
    // with a hard timeout. A hang in async lowering would otherwise deadlock
    // the test host until xunit's per-collection timeout (or worse, never).
    private static void InvokeWithHangGuard(MethodInfo entry, int timeoutMs = 5_000)
    {
        Exception captured = null;
        var thread = new System.Threading.Thread(() =>
        {
            try
            {
                entry.Invoke(null, null);
            }
            catch (Exception ex)
            {
                captured = ex;
            }
        });
        thread.IsBackground = true;
        thread.Start();
        var finished = thread.Join(timeoutMs);
        Assert.True(
            finished,
            "Compiled entry-point did not complete within "
                + timeoutMs
                + " ms — async lowering hang (bug #502 sub-bug 502-b regression).");

        if (captured != null)
        {
            throw new InvalidOperationException("Compiled entry-point threw.", captured);
        }
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_async_instance_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
