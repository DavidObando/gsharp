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
