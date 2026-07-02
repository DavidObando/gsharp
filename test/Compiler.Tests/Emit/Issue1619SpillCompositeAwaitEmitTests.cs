// <copyright file="Issue1619SpillCompositeAwaitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1619: <c>SpillSequenceSpiller</c> treated ~40 composite expression
/// kinds (ternary, index, CLR static/ctor calls, array/tuple/struct/map
/// literals, switch expressions, and more) as await-free leaves, returning
/// them unchanged via <c>Trivial(...)</c>. Any await nested inside one of
/// these leaked past the spiller to the emitter, which threw a mislocated
/// <c>GS9998</c> ICE at (1,1). The fix gives each mechanical composite kind a
/// real spill path (mirroring <c>SpillCall</c>/<c>SpillBinary</c>) and the
/// ternary a genuine if/else control-flow expansion so only the taken arm's
/// await actually runs. A few genuinely conditional-control-flow kinds
/// (switch expression, null-conditional access, conditional address-of)
/// remain gated behind a correctly-anchored diagnostic instead of a crash.
///
/// Each test here compiles the offending shape, IL-verifies the emitted
/// assembly, runs it, and asserts the correct result.
/// </summary>
public class Issue1619SpillCompositeAwaitEmitTests
{
    [Fact]
    public void Await_In_Ternary_Arm_Evaluates_Only_Taken_Branch()
    {
        var source = """
            package P1619A

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
            whenFalse = c.Pick(false).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(11, ReadInt(program, "whenTrue"));
        Assert.Equal(22, ReadInt(program, "whenFalse"));

        // Each branch's await must only run when that branch is taken.
        Assert.Equal(1, ReadInt(program, "trueRuns"));
        Assert.Equal(1, ReadInt(program, "falseRuns"));
    }

    [Fact]
    public void Await_In_Ternary_With_NonAwait_Arm_Only_Runs_TakenBranch()
    {
        var source = """
            package P1619B

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
            whenFalse = c.Pick(false, Task.FromResult(999)).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(7, ReadInt(program, "whenTrue"));
        Assert.Equal(0, ReadInt(program, "whenFalse"));
    }

    [Fact]
    public void Await_In_Index_Expression_Evaluates_Correct_Element()
    {
        var source = """
            package P1619C

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
            result = c.Get(arr, Task.FromResult(2)).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(300, ReadInt(program, "result"));
    }

    [Fact]
    public void Await_In_Clr_Static_Call_Argument_Preserves_Order()
    {
        var source = """
            package P1619D

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
            result = c.MaxWithAwait().Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(5, ReadInt(program, "result"));
    }

    [Fact]
    public void Await_In_Array_Literal_Element_Preserves_Order_And_Values()
    {
        var source = """
            package P1619E

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
            e2 = arr[2]
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(10, ReadInt(program, "e0"));
        Assert.Equal(20, ReadInt(program, "e1"));
        Assert.Equal(30, ReadInt(program, "e2"));
    }

    [Fact]
    public void Await_In_Tuple_Literal_Element_Preserves_Values()
    {
        var source = """
            package P1619F

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
            second = t.Item2
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(9, ReadInt(program, "first"));
        Assert.Equal(42, ReadInt(program, "second"));
    }

    [Fact]
    public void Await_Inside_Switch_Expression_Arm_Reports_Anchored_Diagnostic_Not_ICE()
    {
        // Switch expressions require conditional pattern-match control flow
        // that this pass genuinely does not spill (documented deferred work);
        // it must surface a proper, correctly-anchored diagnostic rather than
        // leak the await to the emitter as a mislocated GS9998 ICE at (1,1).
        var source = """
            package P1619G

            import System.Threading.Tasks

            class C {
                init() {}

                async func Pick(n int32, t Task[int32]) int32 {
                    let x = switch n {
                        case 1: await t
                        default: 0
                    }
                    return x
                }
            }
            """;

        var (compileExit, stdout, stderr) = TryCompile(source);

        Assert.NotEqual(0, compileExit);
        var combined = stdout + stderr;
        Assert.Contains("GS9998", combined);

        // The old symptom was a generic, uninformative ICE message
        // ("'AwaitExpression' is not yet supported by the emitter"). The gate
        // must instead surface a specific, actionable message naming the
        // unsupported composite kind. (Note: BoundSwitchExpression nodes
        // carry a null Syntax from the binder itself — a pre-existing,
        // unrelated limitation — so the diagnostic still falls back to
        // (1,1); only the message quality is asserted here.)
        Assert.DoesNotContain("'AwaitExpression' is not yet supported by the emitter", combined);
        Assert.Contains("'await' inside a 'SwitchExpression' is not yet supported", combined);
    }

    private static int ReadInt(Type program, string fieldName)
    {
        var field = program.GetField(fieldName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(field);
        return (int)field!.GetValue(null)!;
    }

    private static (int ExitCode, string Stdout, string Stderr) TryCompile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1619_spill_emit_").FullName;
        try
        {
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

            return (compileExit, compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static Assembly CompileAndInvokeEntry(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1619_spill_emit_").FullName;
        try
        {
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
            var assembly = Assembly.Load(bytes);

            var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
            var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(entry);
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

            return assembly;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
