// <copyright file="AsyncConditionAwaitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1266: an <c>await</c> used inside an <c>if</c>/<c>while</c>/<c>for</c>/
/// <c>do-while</c> condition (or a <c>for</c> increment) previously leaked an
/// un-lowered <c>BoundAwaitExpression</c> to the emitter, which threw
/// <c>GS9998: Bound expression kind 'AwaitExpression' is not yet supported by
/// the emitter.</c> The statement binder and the Lowerer desugar every branch
/// and loop into label/goto form, so the condition await lives inside a
/// <c>BoundConditionalGotoStatement</c>; the spiller now spills those awaits the
/// same way it already handled <c>let</c>/<c>return</c> initializers. Each test
/// here compiles the offending shape, IL-verifies the emitted assembly, and runs
/// it to assert the correct branch/iteration behaviour.
/// </summary>
public class AsyncConditionAwaitEmitTests
{
    [Fact]
    public void Await_In_If_Condition_Takes_Correct_Branch()
    {
        var source = """
            package P

            import System.Threading.Tasks

            class C {
                init() {}

                async func F(tk Task[int32]) int32 {
                    if (await tk) != 5 { return 1 }
                    return 0
                }
            }

            public var whenEqual = -1
            public var whenNotEqual = -1
            let c = C()
            whenEqual = c.F(Task.FromResult(5)).Result
            whenNotEqual = c.F(Task.FromResult(9)).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        // (await 5) != 5 is false -> falls through -> returns 0.
        Assert.Equal(0, ReadInt(program, "whenEqual"));

        // (await 9) != 5 is true -> returns 1.
        Assert.Equal(1, ReadInt(program, "whenNotEqual"));
    }

    [Fact]
    public void Await_In_While_Condition_Reevaluates_Each_Iteration()
    {
        var source = """
            package P

            import System.Threading.Tasks

            class C {
                init() {}

                async func SumBelow(n int32) int32 {
                    var i = 0
                    var sum = 0
                    while await Task.FromResult(i) < n {
                        sum = sum + i
                        i = i + 1
                    }
                    return sum
                }
            }

            public var sum = -1
            let c = C()
            sum = c.SumBelow(5).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        // 0 + 1 + 2 + 3 + 4 == 10; the awaited condition must run 6 times.
        Assert.Equal(10, ReadInt(program, "sum"));
    }

    [Fact]
    public void Await_In_For_Condition_Reevaluates_Each_Iteration()
    {
        var source = """
            package P

            import System.Threading.Tasks

            class C {
                init() {}

                async func ForSum(n int32) int32 {
                    var sum = 0
                    for var i = 0; await Task.FromResult(i) < n; i = i + 1 {
                        sum = sum + i
                    }
                    return sum
                }
            }

            public var sum = -1
            let c = C()
            sum = c.ForSum(4).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        // 0 + 1 + 2 + 3 == 6.
        Assert.Equal(6, ReadInt(program, "sum"));
    }

    [Fact]
    public void Await_In_Both_Operands_Of_Condition()
    {
        var source = """
            package P

            import System.Threading.Tasks

            class C {
                init() {}

                async func Compare(a Task[int32], b Task[int32]) int32 {
                    if (await a) < (await b) { return 100 }
                    return 200
                }
            }

            public var less = -1
            public var greater = -1
            let c = C()
            less = c.Compare(Task.FromResult(1), Task.FromResult(2)).Result
            greater = c.Compare(Task.FromResult(3), Task.FromResult(2)).Result
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(100, ReadInt(program, "less"));
        Assert.Equal(200, ReadInt(program, "greater"));
    }

    [Fact]
    public void Await_Right_Operand_Of_LogicalAnd_Is_Short_Circuited()
    {
        var source = """
            package P

            import System.Threading.Tasks

            public var rightRuns = 0

            func rightTask() Task[bool] {
                rightRuns = rightRuns + 1
                return Task.FromResult(true)
            }

            class C {
                init() {}

                async func AndShort(left bool) int32 {
                    if left && (await rightTask()) { return 1 }
                    return 0
                }
            }

            public var shortResult = -1
            public var shortRuns = -1
            public var fullResult = -1
            public var fullRuns = -1
            let c = C()
            rightRuns = 0
            shortResult = c.AndShort(false).Result
            shortRuns = rightRuns
            rightRuns = 0
            fullResult = c.AndShort(true).Result
            fullRuns = rightRuns
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        // left=false short-circuits: the right operand (and its await) must not run.
        Assert.Equal(0, ReadInt(program, "shortResult"));
        Assert.Equal(0, ReadInt(program, "shortRuns"));

        // left=true forces the right operand: the await runs exactly once.
        Assert.Equal(1, ReadInt(program, "fullResult"));
        Assert.Equal(1, ReadInt(program, "fullRuns"));
    }

    [Fact]
    public void Await_Right_Operand_Of_LogicalOr_Is_Short_Circuited()
    {
        var source = """
            package P

            import System.Threading.Tasks

            public var rightRuns = 0

            func rightTask() Task[bool] {
                rightRuns = rightRuns + 1
                return Task.FromResult(false)
            }

            class C {
                init() {}

                async func OrShort(left bool) int32 {
                    if left || (await rightTask()) { return 1 }
                    return 0
                }
            }

            public var shortResult = -1
            public var shortRuns = -1
            public var fullResult = -1
            public var fullRuns = -1
            let c = C()
            rightRuns = 0
            shortResult = c.OrShort(true).Result
            shortRuns = rightRuns
            rightRuns = 0
            fullResult = c.OrShort(false).Result
            fullRuns = rightRuns
            """;

        var assembly = CompileAndInvokeEntry(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        // left=true short-circuits: the right operand (and its await) must not run.
        Assert.Equal(1, ReadInt(program, "shortResult"));
        Assert.Equal(0, ReadInt(program, "shortRuns"));

        // left=false forces the right operand: the await runs, condition stays false.
        Assert.Equal(0, ReadInt(program, "fullResult"));
        Assert.Equal(1, ReadInt(program, "fullRuns"));
    }

    private static int ReadInt(Type program, string fieldName)
    {
        var field = program.GetField(fieldName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(field);
        return (int)field!.GetValue(null)!;
    }

    private static Assembly CompileAndInvokeEntry(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_async_cond_emit_").FullName;
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
