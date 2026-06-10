// <copyright file="Issue655AsyncIteratorFieldAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #655: reading a class field from inside an async-yield iterator
/// (<c>async func ... IAsyncEnumerable[T]</c>) must not trigger GS9998
/// ("Variable 'X' has no local slot or parameter index").
/// The async-iterator state-machine must capture <c>this</c> and proxy
/// all field reads/writes through the captured proxy field.
/// </summary>
public class Issue655AsyncIteratorFieldAccessEmitTests
{
    #region Exact issue repro: field read as method call receiver

    [Fact]
    public void AsyncIterator_FieldRead_As_MethodCallReceiver_No_ICE()
    {
        // Exact repro from issue #655: Counter.Enter() triggers GS9998.
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Counter class {
                Value int32
                func Enter() { Value++ }
            }

            type Probe class {
                Counter Counter = Counter()

                async func GetAsync() IAsyncEnumerable[int32] {
                    Counter.Enter()
                    yield 1
                    await Task.Delay(1)
                    yield 2
                }
            }

            public var result = 0
            let p = Probe()
            let e = p.GetAsync().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            result = result + p.Counter.Value
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield 1 + yield 2 + Counter.Value (incremented once by Enter()) = 4
        Assert.Equal(4, result);
    }

    #endregion

    #region Field read after yield and after await

    [Fact]
    public void AsyncIterator_FieldRead_After_Yield_And_Await()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Sensor class {
                Reading int32

                async func Measure() IAsyncEnumerable[int32] {
                    Reading = 10
                    yield Reading
                    await Task.Delay(1)
                    Reading = Reading + 5
                    yield Reading
                }
            }

            public var result = 0
            let s = Sensor()
            let e = s.Measure().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield 10 + yield 15 = 25
        Assert.Equal(25, result);
    }

    #endregion

    #region Field write inside async iterator (before and after first yield)

    [Fact]
    public void AsyncIterator_FieldWrite_Before_And_After_FirstYield()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Tracker class {
                Writes int32

                async func Track() IAsyncEnumerable[int32] {
                    Writes = 1
                    yield Writes
                    await Task.Delay(1)
                    Writes = 2
                    yield Writes
                    Writes = 3
                }
            }

            public var result = 0
            let t = Tracker()
            let e = t.Track().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            // Drain the iterator to completion
            e.MoveNextAsync().AsTask().Wait()
            result = result + t.Writes
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield 1 + yield 2 + Writes(3) = 6
        Assert.Equal(6, result);
    }

    #endregion

    #region Field access with method call on field (Counter pattern)

    [Fact]
    public void AsyncIterator_FieldAccess_MethodCallOnField_Multiple_Calls()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Accumulator class {
                Total int32
                func Add(n int32) { Total = Total + n }
            }

            type Worker class {
                Acc Accumulator = Accumulator()

                async func Process() IAsyncEnumerable[int32] {
                    Acc.Add(10)
                    yield 1
                    await Task.Delay(1)
                    Acc.Add(20)
                    yield 2
                    Acc.Add(30)
                    yield 3
                }
            }

            public var result = 0
            let w = Worker()
            let e = w.Process().GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            result = result + w.Acc.Total
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield 1+2+3 + Acc.Total(10+20+30) = 6 + 60 = 66
        Assert.Equal(66, result);
    }

    #endregion

    #region Field increment (++) inside async iterator

    [Fact]
    public void AsyncIterator_FieldIncrement_Inside_Iterator()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Sequencer class {
                Step int32

                async func Generate() IAsyncEnumerable[int32] {
                    Step++
                    yield Step
                    await Task.Delay(1)
                    Step++
                    yield Step
                    Step++
                    yield Step
                }
            }

            public var result = 0
            let s = Sequencer()
            let e = s.Generate().GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield 1 + yield 2 + yield 3 = 6
        Assert.Equal(6, result);
    }

    #endregion

    #region Multiple field accesses across yields and awaits

    [Fact]
    public void AsyncIterator_MultipleFieldAccesses_Across_Yields_And_Awaits()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type State class {
                A int32
                B int32

                async func Compute() IAsyncEnumerable[int32] {
                    A = 1
                    B = 2
                    yield A + B
                    await Task.Delay(1)
                    A = A + B
                    yield A
                    await Task.Delay(1)
                    B = A + B
                    yield B
                }
            }

            public var result = 0
            let s = State()
            let e = s.Compute().GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield (1+2)=3 + yield A(1+2)=3 + yield B(3+2)=5 = 11
        Assert.Equal(11, result);
    }

    #endregion

    #region Field read in value position (let v = Field)

    [Fact]
    public void AsyncIterator_FieldRead_In_ValuePosition()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Config class {
                Scale int32

                init(s int32) {
                    Scale = s
                }

                async func Generate() IAsyncEnumerable[int32] {
                    let s = Scale
                    yield s
                    await Task.Delay(1)
                    let s2 = Scale * 2
                    yield s2
                }
            }

            public var result = 0
            let c = Config(5)
            let e = c.Generate().GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield 5 + yield 10 = 15
        Assert.Equal(15, result);
    }

    #endregion

    #region async sequence[T] variant (alternate syntax)

    [Fact]
    public void AsyncIterator_AsyncSequence_FieldAccess_No_ICE()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Counter class {
                Value int32
                func Enter() { Value++ }
            }

            type Probe class {
                Counter Counter = Counter()

                async func GetAsync() async sequence[int32] {
                    Counter.Enter()
                    yield 1
                    await Task.Delay(1)
                    Counter.Enter()
                    yield 2
                }
            }

            public var result = 0
            let p = Probe()
            let e = p.GetAsync().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            result = result + p.Counter.Value
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // yield 1 + yield 2 + Counter.Value (incremented twice) = 5
        Assert.Equal(5, result);
    }

    #endregion

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_655_").FullName;
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

        // Run the entry point
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, null);

        return assembly;
    }

    private static T GetResult<T>(Assembly assembly)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);
        return (T)resultField!.GetValue(null)!;
    }

    #endregion
}
