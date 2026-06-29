// <copyright file="Issue1431NativeFunctionTypeInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1431: emit-time generic type inference must descend into a native
/// G# function type <c>(T1, ...) -&gt; R</c> at both the parameter and return
/// positions when building a generic-method <c>MethodSpec</c>. Before the fix,
/// a type parameter that appeared ONLY in the return slot of a native
/// function-type parameter (e.g. <c>keySelector (TResult) -&gt; TKey</c>)
/// threw an internal compiler error (GS9998 / InvalidOperationException)
/// because the structural unifier had no <c>FunctionTypeSymbol</c> branch.
/// The equivalent declaration using a CLR <c>Func[...]</c> delegate already
/// inferred fine.
/// </summary>
/// <remarks>
/// These tests also pin the latent emitter conversion gap the inference ICE
/// previously masked: a lambda bound against a native
/// <c>(T) -&gt; IEnumerable[R]</c> parameter yields an
/// <c>IEnumerable&lt;System.Int64&gt;</c> body whose closed CLR shape differs
/// in representation (but not identity) from the type-erased substituted
/// target return, which is a no-op reference conversion at the IL level.
/// </remarks>
public class Issue1431NativeFunctionTypeInferenceEmitTests
{
    [Fact]
    public void NativeFunctionType_TypeParamOnlyInReturnPosition_InfersAndRuns()
    {
        // `TKey` appears ONLY in the return position of the native function
        // type `(TResult) -> TKey` and nowhere else in a parameter or the
        // method return — the exact shape that threw GS9998 before the fix.
        var source = """
            package Probe1431A
            import System.Collections.Generic

            func Project1431[TSource, TResult, TKey](
                    source IEnumerable[TSource],
                    selector (TSource) -> TResult,
                    keySelector (TResult) -> TKey) TResult {
                for s in source {
                    return selector(s)
                }

                return default(TResult?)!!
            }

            public var result = Project1431([]int32{5, 6, 7}, (s int32) -> s * 10, (t int32) -> t)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(50, GetIntField(assembly, "result"));
    }

    [Fact]
    public void NativeFunctionType_ReturningEnumerable_InfersAndRuns()
    {
        // `TResult` appears only inside the function-type return shape
        // `(TSource) -> IEnumerable[TResult]`. The unifier must recurse
        // through the FunctionTypeSymbol's return slot and then through the
        // `IEnumerable[...]` generic arguments. The lambda body
        // (`IEnumerable[int64]`) flowing into the substituted target return
        // also exercises the no-op identity reference conversion the
        // inference ICE previously masked.
        var source = """
            package Probe1431B
            import System.Collections.Generic

            func Pair1431(v int64) IEnumerable[int64] {
                yield v
                yield v * 10
            }

            func FlatFirst1431[TSource, TResult](
                    source IEnumerable[TSource],
                    selector (TSource) -> IEnumerable[TResult]) IEnumerable[TResult] {
                for s in source {
                    return selector(s)
                }

                return default(IEnumerable[TResult]?)!!
            }

            public var total = 0
            for v in FlatFirst1431([]int32{1, 2, 3}, (s int32) -> Pair1431(int64(s))) {
                total = total + int32(v)
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(11, GetIntField(assembly, "total"));
    }

    [Fact]
    public void NativeFunctionType_ExtensionMethodIssueShape_CompilesCleanLibrary()
    {
        // The literal issue repro: an extension method whose constrained
        // type parameter `TKey` only appears in the return slot of a native
        // function-type parameter. Compiles to a library with no GS9998 ICE.
        var source = """
            package Probe1431C
            import System
            import System.Collections.Generic

            func (source IEnumerable[TSource]) IB1431[TSource, TResult, TKey IComparable[TKey]](
                    selector (TSource) -> IEnumerable[TResult],
                    keySelector (TResult) -> TKey) IEnumerable[TResult] -> default(IEnumerable[TResult]?)!!

            func F1431(xs IEnumerable[int32]) {
                let r = xs.IB1431((s int32) -> default(IEnumerable[int64]?)!!, (t int64) -> t)
            }
            """;

        // Compiling to a library is sufficient — the ICE fired during emit
        // while building the MethodSpec for the `IB1431` call, so a clean
        // exit proves the fix.
        var assembly = CompileLibrary(source);
        Assert.NotNull(assembly);
    }

    private static Assembly CompileAndRun(string source)
    {
        var outPath = CompileToFile(source, target: "exe");

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static Assembly CompileLibrary(string source)
    {
        var outPath = CompileToFile(source, target: "library");
        return Assembly.LoadFile(outPath);
    }

    private static string CompileToFile(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1431_").FullName;
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
                "/target:" + target,
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
        return outPath;
    }

    private static int GetIntField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (int)field!.GetValue(null)!;
    }
}
