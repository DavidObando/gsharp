// <copyright file="Issue641AsyncIteratorClassMemberEmitTests.cs" company="GSharp">
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
/// Issue #641: async iterator (<c>async func ... async sequence[T] { yield ... }</c>)
/// declared as a class member must:
///   1. Nest the synthesised state-machine type inside the enclosing class (not
///      under <c>&lt;Program&gt;</c>) so the kickoff method retains CLR access.
///   2. Hoist <c>this</c> into a <c>&lt;&gt;4__this</c> proxy field so the
///      MoveNext body can access instance members across yield/await suspension.
/// Also regression-tests sync iterators on a class and async non-iterator methods.
/// </summary>
public class Issue641AsyncIteratorClassMemberEmitTests
{
    #region Async iterator on class — no this capture (Symptom 2)

    [Fact]
    public void AsyncIterator_On_Class_No_Capture_Runs_Without_MethodAccessException()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Producer class {
                init() {}

                async func ProduceAsync() async sequence[int32] {
                    yield 1
                    await Task.Delay(1)
                    yield 2
                }
            }

            public var result = 0
            let p = Producer()
            let e = p.ProduceAsync().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(3, result);
    }

    #endregion

    #region Async iterator on class — reads instance field

    [Fact]
    public void AsyncIterator_On_Class_Reads_Instance_Field()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Counter class(Start int32) {
                async func CountUp() async sequence[int32] {
                    yield Start
                    await Task.Delay(1)
                    yield Start + 1
                }
            }

            public var result = 0
            let c = Counter(10)
            let e = c.CountUp().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(21, result);
    }

    #endregion

    #region Async iterator on class — writes instance field (Symptom 1 ICE)

    [Fact]
    public void AsyncIterator_On_Class_Writes_Instance_Field_No_ICE()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type CapturingExecutor class {
                var Calls int32
                init() {}

                async func ProduceAsync() async sequence[int32] {
                    Calls = Calls + 1
                    yield 1
                    await Task.Delay(1)
                    yield 2
                }
            }

            public var result = 0
            let p = CapturingExecutor()
            let e = p.ProduceAsync().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            result = result + p.Calls
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // 1 + 2 + 1 (Calls incremented once) = 4
        Assert.Equal(4, result);
    }

    #endregion

    #region Async iterator on class — calls instance method

    [Fact]
    public void AsyncIterator_On_Class_Calls_Instance_Method()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Doubler class(Factor int32) {
                func Apply(n int32) int32 {
                    return Factor * n
                }

                async func Produce(x int32) async sequence[int32] {
                    yield Apply(x)
                    await Task.Delay(1)
                    yield Apply(x + 1)
                }
            }

            public var result = 0
            let d = Doubler(3)
            let e = d.Produce(2).GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // Apply(2)=6, Apply(3)=9 => 15
        Assert.Equal(15, result);
    }

    #endregion

    #region Async iterator on class — primary constructor field

    [Fact]
    public void AsyncIterator_On_Class_Uses_Primary_Ctor_Field()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Offset class(Base int32) {
                async func Generate(n int32) async sequence[int32] {
                    yield Base + n
                    await Task.Delay(1)
                    yield Base + n + 1
                }
            }

            public var result = 0
            let o = Offset(100)
            let e = o.Generate(5).GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // 105 + 106 = 211
        Assert.Equal(211, result);
    }

    #endregion

    #region Async iterator on class — multiple yield and await interleaved

    [Fact]
    public void AsyncIterator_On_Class_Multiple_Yield_Await_Interleaved()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Multi class {
                init() {}

                async func Items() async sequence[int32] {
                    yield 1
                    await Task.Delay(1)
                    yield 2
                    await Task.Delay(1)
                    yield 3
                    await Task.Delay(1)
                    yield 4
                }
            }

            public var result = 0
            let m = Multi()
            let e = m.Items().GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(10, result);
    }

    #endregion

    #region Async iterator on class — early return / break

    [Fact]
    public void AsyncIterator_On_Class_Early_Return()
    {
        // Test conditional exit from async iterator via state reaching end
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Early class(Limit int32) {
                async func Items() async sequence[int32] {
                    yield 1
                    await Task.Delay(1)
                    if Limit >= 2 {
                        yield 2
                    }
                }
            }

            public var result = 0
            let e1 = Early(1)
            let iter1 = e1.Items().GetAsyncEnumerator()
            for iter1.MoveNextAsync().AsTask().Result {
                result = result + iter1.Current
            }

            let e2 = Early(5)
            let iter2 = e2.Items().GetAsyncEnumerator()
            for iter2.MoveNextAsync().AsTask().Result {
                result = result + iter2.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        // e1: yields 1 only. e2: yields 1 + 2 = 3. Total = 4
        Assert.Equal(4, result);
    }

    #endregion

    #region Async iterator returning non-primitive element type

    [Fact]
    public void AsyncIterator_On_Class_Returns_Non_Primitive_Element()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type StringGen class(Prefix string) {
                async func Greetings() async sequence[string] {
                    yield Prefix + " hello"
                    await Task.Delay(1)
                    yield Prefix + " world"
                }
            }

            public var result = ""
            let g = StringGen("hi")
            let e = g.Greetings().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + " " + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<string>(assembly);
        Assert.Equal("hi hello hi world", result);
    }

    #endregion

    #region State machine nested inside declaring class

    [Fact]
    public void AsyncIterator_State_Machine_Nested_Inside_Declaring_Class()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            type Yielder class {
                init() {}

                async func Items() async sequence[int32] {
                    yield 42
                    await Task.Delay(1)
                }
            }

            public var result = 0
            let y = Yielder()
            let e = y.Items().GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(42, result);

        // Verify state-machine type is nested under Yielder
        var yielderType = assembly.GetTypes().SingleOrDefault(t => t.Name == "Yielder");
        Assert.NotNull(yielderType);
        var nestedTypes = yielderType!.GetNestedTypes(BindingFlags.NonPublic);
        Assert.Contains(nestedTypes, t => t.Name.Contains("<Items>d__"));
    }

    #endregion

    #region Sync iterator on class — regression test

    [Fact]
    public void SyncIterator_On_Class_Reads_Instance_Field_Regression()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            type Repeater class(Value int32) {
                func Repeat(n int32) sequence[int32] {
                    var i = 0
                    for i < n {
                        yield Value
                        i = i + 1
                    }
                }
            }

            public var result = 0
            let r = Repeater(7)
            for item in r.Repeat(3) {
                result = result + item
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(21, result);
    }

    #endregion

    #region Async non-iterator on class — regression test

    [Fact]
    public void AsyncNonIterator_On_Class_Captures_This_Regression()
    {
        var source = """
            package Probe
            import System.Threading.Tasks

            type Adder class(Base int32) {
                async func Add(n int32) int32 {
                    await Task.Delay(1)
                    return Base + n
                }
            }

            public var result = 0
            let a = Adder(40)
            result = a.Add(2).Result
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(42, result);
    }

    #endregion

    #region Free-function async iterator — regression test

    [Fact]
    public void FreeFunctionAsyncIterator_Still_Works()
    {
        var source = """
            package Probe
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Generate(start int32) async sequence[int32] {
                yield start
                await Task.Delay(1)
                yield start + 1
            }

            public var result = 0
            let e = Generate(5).GetAsyncEnumerator()
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            if e.MoveNextAsync().AsTask().Result {
                result = result + e.Current
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(11, result);
    }

    #endregion

    #region Sync iterator on class — no this capture, nesting regression

    [Fact]
    public void SyncIterator_On_Class_No_Capture_Nests_Under_Declaring_Class()
    {
        var source = """
            package Probe
            import System.Collections.Generic

            type Simple class {
                init() {}

                func Items() sequence[int32] {
                    yield 1
                    yield 2
                    yield 3
                }
            }

            public var result = 0
            let s = Simple()
            for item in s.Items() {
                result = result + item
            }
            """;

        var assembly = CompileAndRun(source);
        var result = GetResult<int>(assembly);
        Assert.Equal(6, result);

        // Verify nesting
        var simpleType = assembly.GetTypes().SingleOrDefault(t => t.Name == "Simple");
        Assert.NotNull(simpleType);
        var nestedTypes = simpleType!.GetNestedTypes(BindingFlags.NonPublic);
        Assert.Contains(nestedTypes, t => t.Name.Contains("<Items>d__"));
    }

    #endregion

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_641_").FullName;
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
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

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
