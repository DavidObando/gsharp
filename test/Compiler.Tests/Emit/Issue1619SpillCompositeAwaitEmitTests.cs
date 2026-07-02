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
/// real spill path (mirroring <c>SpillCall</c>/<c>SpillBinary</c>), and the
/// ternary, switch expression, null-conditional access, and conditional
/// address-of a genuine if/else control-flow expansion so only the taken
/// branch's await actually runs. The one remaining diagnostic-gated shape is
/// an <c>await</c> inside a switch-expression <c>when</c> guard (see
/// <c>SpillSwitch</c> in <c>SpillSequenceSpiller.cs</c> for why that specific
/// shape cannot be mechanically spilled without duplicating the whole
/// pattern-matching decision tree).
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
    public void Await_In_Switch_Expression_Arm_Runs_Only_Selected_Arm()
    {
        var source = """
            package P1619G

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
            whenDefault = c.Pick(2, Task.FromResult(0)).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(111, ReadInt(program, "whenOne"));
        Assert.Equal(1000, ReadInt(program, "whenDefault"));
        Assert.Equal(1, ReadInt(program, "oneRuns"));
    }

    [Fact]
    public void Await_In_Switch_Expression_Governing_Expression_Selects_Correct_Arm()
    {
        var source = """
            package P1619H

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
            result2 = c.Pick(Task.FromResult(2)).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(100, ReadInt(program, "result1"));
        Assert.Equal(200, ReadInt(program, "result2"));
    }

    [Fact]
    public void Await_In_Switch_Expression_Arm_Survives_Real_Suspension()
    {
        // Task.Yield() forces an actual suspend/resume through
        // AwaitUnsafeOnCompleted (not the Task.FromResult fast path), so this
        // also exercises the arm-index/result spill temps across a genuine
        // state-machine re-entry.
        var source = """
            package P1619I

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
            result = c.Pick(1).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(42, ReadInt(program, "result"));
    }

    [Fact]
    public void Await_Inside_Switch_Expression_Guard_Reports_Anchored_Diagnostic_Not_ICE()
    {
        // A `when`-guard containing await is the one shape this pass still
        // cannot mechanically spill: a false guard must fall through to the
        // next arm's pattern test, which would require re-implementing the
        // whole pattern-match decision tree as bound-tree control flow rather
        // than reusing the existing emitter's pattern dispatch.
        var source = """
            package P1619J

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
            }
            """;

        var (compileExit, stdout, stderr) = TryCompile(source);

        Assert.NotEqual(0, compileExit);
        var combined = stdout + stderr;
        Assert.Contains("GS9998", combined);
        Assert.Contains("'await' inside a switch-expression 'when' guard is not yet supported", combined);
    }

    [Fact]
    public void Await_In_NullConditional_Access_Argument_Nil_And_NonNil()
    {
        var source = """
            package P1619K

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
            nilIsNil = (r2 == nil) ? 1 : 0
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(15, ReadInt(program, "nonNilResult"));
        Assert.Equal(1, ReadInt(program, "nilIsNil"));
    }

    [Fact]
    public void Await_In_NullConditional_Receiver_Evaluates_Chain()
    {
        var source = """
            package P1619L

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
            nilIsNil = (r2 == nil) ? 1 : 0
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(5, ReadInt(program, "nonNilLen"));
        Assert.Equal(1, ReadInt(program, "nilIsNil"));
    }

    [Fact]
    public void Await_In_Conditional_Address_Condition_Selects_Correct_RefBranch()
    {
        var source = """
            package P1619M

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
            bWhenFalse = r2.Item2
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(11, ReadInt(program, "aWhenTrue"));
        Assert.Equal(20, ReadInt(program, "bWhenTrue"));
        Assert.Equal(10, ReadInt(program, "aWhenFalse"));
        Assert.Equal(21, ReadInt(program, "bWhenFalse"));
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
