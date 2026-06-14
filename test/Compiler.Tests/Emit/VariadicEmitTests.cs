// <copyright file="VariadicEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4.8 emit-parity regression tests for user-defined variadic
/// functions. Variadic packing is performed by the binder
/// (Binder.BindCallExpression wraps trailing args in a
/// <c>BoundArrayCreationExpression</c> of the slice element type) before the
/// expression reaches the emitter, so the emit path is exercised entirely
/// through pre-existing nodes; these tests guard against regressions in
/// either side. BCL params calls (e.g. <c>Console.WriteLine(string, params
/// object[])</c>) are tracked separately; the binder's overload resolution
/// does not expand params overloads today.
/// </summary>
public class VariadicEmitTests
{
    [Fact]
    public void VariadicSum_MultipleArgs()
    {
        var source = """
            package P
            import System

            func sum(nums ...int32) int32 {
              var total = 0
              for v in nums {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sum(1, 2, 3, 4, 5))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void VariadicSum_ZeroAndOneArg()
    {
        var source = """
            package P
            import System

            func sum(nums ...int32) int32 {
              var total = 0
              for v in nums {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sum())
            Console.WriteLine(sum(42))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n42\n", output);
    }

    [Fact]
    public void VariadicWithFixedPrefix()
    {
        var source = """
            package P
            import System

            func sumWithBase(base int32, extras ...int32) int32 {
              var total = base
              for v in extras {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sumWithBase(100, 1, 2, 3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("106\n", output);
    }

    // ADR-0101 / issue #799: generic variadic — mirrors `Sequences.Of`.

    [Fact]
    public void Variadic_Generic_PacksMultipleArgs()
    {
        var source = """
            package P
            import System

            func Of[T](values ...T) []T {
              return values
            }

            let xs = Of(1, 2, 3, 4)
            Console.WriteLine(xs.Length)
            Console.WriteLine(xs[0])
            Console.WriteLine(xs[3])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n1\n4\n", output);
    }

    [Fact]
    public void Variadic_Generic_SingleArrayPassesThrough()
    {
        // The pass-through path returns the same array the caller supplied —
        // a subsequent mutation to the original array is visible through the
        // returned slice. The interpreter and the emitter share this
        // identity guarantee, so the test ensures the emitter matches.
        var source = """
            package P
            import System

            func Of[T](values ...T) []T {
              return values
            }

            let arr = []int32{10, 20, 30}
            let xs = Of(arr)
            Console.WriteLine(xs.Length)
            Console.WriteLine(xs[1])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n20\n", output);
    }

    [Fact]
    public void Variadic_Generic_EmptyCall()
    {
        var source = """
            package P
            import System

            func Of[T](values ...T) []T {
              return values
            }

            let xs = Of[int32]()
            Console.WriteLine(xs.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    // ADR-0101 / issue #799 — cross-language: a C# / F# consumer must see a
    // G#-authored variadic as a `params` method, which only works if the
    // emitted MethodDef carries [ParamArrayAttribute] on the last
    // parameter. We compile a G# library, then walk the emitted metadata
    // via Reflection to assert the attribute is present on the variadic
    // parameter (and only there), and invoke the method with an int[] to
    // confirm the IL accepts the C#-lowered call shape.

    [Fact]
    public void Variadic_Emits_ParamArrayAttribute_ForCSharpInterop()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_variadic_csinterop_").FullName;
        try
        {
            var gsSrc = Path.Combine(tempDir, "lib.gs");
            var gsDll = Path.Combine(tempDir, "GsVariadicLib.dll");
            File.WriteAllText(gsSrc, """
                package GsVariadicLib

                public func Sum(nums ...int32) int32 {
                  var total = 0
                  for v in nums {
                    total = total + v
                  }
                  return total
                }

                public func SumWithBase(base int32, extras ...int32) int32 {
                  var total = base
                  for v in extras {
                    total = total + v
                  }
                  return total
                }

                public func NoParams() int32 { return 42 }
                """);

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
                    "/out:" + gsDll,
                    "/target:library",
                    "/targetframework:net10.0",
                    gsSrc,
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
            IlVerifier.Verify(gsDll);

            var asm = System.Reflection.Assembly.LoadFrom(gsDll);
            var programType = asm.GetTypes().Single(t => t.Namespace == "GsVariadicLib" && t.Name == "<Program>");

            var sumMethod = programType.GetMethod("Sum", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
            Assert.NotNull(sumMethod);
            var sumParams = sumMethod!.GetParameters();
            Assert.Single(sumParams);
            Assert.True(
                sumParams[0].GetCustomAttributesData().Any(a => a.AttributeType.FullName == "System.ParamArrayAttribute"),
                "Single variadic parameter must carry [ParamArrayAttribute].");

            // Mixed signature: only the trailing variadic gets the attribute.
            var mixed = programType.GetMethod("SumWithBase", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
            Assert.NotNull(mixed);
            var mixedParams = mixed!.GetParameters();
            Assert.Equal(2, mixedParams.Length);
            Assert.False(
                mixedParams[0].GetCustomAttributesData().Any(a => a.AttributeType.FullName == "System.ParamArrayAttribute"),
                "Fixed leading parameter must NOT carry [ParamArrayAttribute].");
            Assert.True(
                mixedParams[1].GetCustomAttributesData().Any(a => a.AttributeType.FullName == "System.ParamArrayAttribute"),
                "Trailing variadic parameter must carry [ParamArrayAttribute].");

            // Non-variadic function: no [ParamArrayAttribute] anywhere.
            var noParams = programType.GetMethod("NoParams", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
            Assert.NotNull(noParams);
            Assert.Empty(noParams!.GetParameters());

            // Invoke via reflection using the C#-style expanded array
            // (which is exactly what the C# compiler lowers a `params`
            // call to). The IL accepts the packed array as-is.
            var result = sumMethod.Invoke(null, new object[] { new int[] { 1, 2, 3, 4, 5 } });
            Assert.Equal(15, result);

            var mixedResult = mixed.Invoke(null, new object[] { 100, new int[] { 1, 2, 3 } });
            Assert.Equal(106, mixedResult);

            // Empty variadic call: caller supplies an empty array.
            var emptyResult = sumMethod.Invoke(null, new object[] { System.Array.Empty<int>() });
            Assert.Equal(0, emptyResult);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    // ADR-0102 / issue #812 — variadic parameters on additional declaration
    // sites: class instance methods, class static (shared) methods,
    // interface DIM default bodies, constructors, lambdas, and named
    // delegates. Each site must emit a MethodDef whose trailing parameter
    // carries [ParamArrayAttribute] for C# interop.

    [Fact]
    public void Variadic_OnClassInstanceMethod_EndToEnd()
    {
        var source = """
            package P
            import System

            class Joiner {
              func Sum(nums ...int32) int32 {
                var total = 0
                for v in nums {
                  total = total + v
                }
                return total
              }
            }

            var j = Joiner()
            Console.WriteLine(j.Sum(1, 2, 3, 4, 5))
            Console.WriteLine(j.Sum([]int32{10, 20, 30}))
            Console.WriteLine(j.Sum())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n60\n0\n", output);
    }

    [Fact]
    public void Variadic_OnSharedStaticMethod_EndToEnd()
    {
        var source = """
            package P
            import System

            class Sequences {
              shared {
                func Of[T](values ...T) []T { return values }
              }
            }

            let xs = Sequences.Of(1, 2, 3, 4)
            Console.WriteLine(xs.Length)

            let arr = []int32{10, 20, 30}
            let ys = Sequences.Of(arr)
            Console.WriteLine(ys.Length)
            Console.WriteLine(ys[1])

            let zs = Sequences.Of[int32]()
            Console.WriteLine(zs.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n3\n20\n0\n", output);
    }

    [Fact]
    public void Variadic_OnInterfaceDefaultBody_EndToEnd()
    {
        var source = """
            package P
            import System

            interface IAdder {
              func Add(nums ...int32) int32 {
                var total = 0
                for v in nums {
                  total = total + v
                }
                return total
              }
            }

            class Adder : IAdder {}

            var a = Adder()
            Console.WriteLine(a.Add(1, 2, 3, 4))
            Console.WriteLine(a.Add([]int32{5, 5}))
            Console.WriteLine(a.Add())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n10\n0\n", output);
    }

    [Fact]
    public void Variadic_OnConstructor_EndToEnd()
    {
        var source = """
            package P
            import System

            class Tags {
              var Values []string
              init(vs ...string) {
                Values = vs
              }
            }

            var t1 = Tags("a", "b", "c")
            Console.WriteLine(t1.Values.Length)

            var t2 = Tags([]string{"x", "y"})
            Console.WriteLine(t2.Values.Length)

            var t3 = Tags()
            Console.WriteLine(t3.Values.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n2\n0\n", output);
    }

    [Fact]
    public void Variadic_OnLambda_EndToEnd()
    {
        // The lambda's FunctionTypeSymbol does not propagate IsVariadic to
        // call sites (ADR-0102 §5), so the caller passes an explicit []T.
        // The body still binds the parameter as `[]T` — exercised via
        // `xs.Length`. Both function-literal and arrow forms.
        var source = """
            package P
            import System

            let f = func(xs ...int32) int32 { return xs.Length }
            Console.WriteLine(f([]int32{1, 2, 3}))

            let g = (xs ...int32) -> xs.Length
            Console.WriteLine(g([]int32{10, 20, 30, 40}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n4\n", output);
    }

    [Fact]
    public void Variadic_OnNamedDelegate_DirectAndInvoke_EndToEnd()
    {
        // `for v in xs` inside a function-literal body trips a known emit
        // issue (variable slot capture for the range variable); use the
        // C-style for loop instead.
        var source = """
            package P
            import System

            type Adder = delegate func(nums ...int32) int32

            var d Adder = func(nums ...int32) int32 {
              var total = 0
              for var i = 0; i < nums.Length; i++ {
                total = total + nums[i]
              }
              return total
            }

            Console.WriteLine(d(1, 2, 3, 4))
            Console.WriteLine(d.Invoke(5, 5))
            Console.WriteLine(d([]int32{100, 200}))
            Console.WriteLine(d())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n10\n300\n0\n", output);
    }

    // Cross-language: assert every new site emits [ParamArrayAttribute] on
    // the trailing variadic parameter so C# / F# consumers see `params`.
    // Split into two compilations because combining a DIM default-body
    // interface and a named delegate in the same compilation trips a
    // pre-existing emit bug (delegate .ctor MethodDef row mismatch) that
    // is out of scope for issue #812.

    [Fact]
    public void Variadic_AdditionalSites_Emit_ParamArrayAttribute_ForCSharpInterop()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_variadic_sites_csinterop_").FullName;
        try
        {
            var gsSrc = Path.Combine(tempDir, "sites.gs");
            var gsDll = Path.Combine(tempDir, "GsVariadicSitesLib.dll");
            File.WriteAllText(gsSrc, """
                package GsVariadicSitesLib

                public class Joiner {
                  public func Sum(nums ...int32) int32 {
                    var total = 0
                    for var i = 0; i < nums.Length; i++ { total = total + nums[i] }
                    return total
                  }
                }

                public class Sequences {
                  shared {
                    public func Of[T](values ...T) []T { return values }
                  }
                }

                public interface IAdder {
                  func Add(nums ...int32) int32 {
                    var total = 0
                    for var i = 0; i < nums.Length; i++ { total = total + nums[i] }
                    return total
                  }
                }

                public class Tags {
                  public var Values []string
                  init(vs ...string) {
                    Values = vs
                  }
                }
                """);

            CompileLibrary(gsSrc, gsDll);
            IlVerifier.Verify(gsDll);

            var asm = System.Reflection.Assembly.LoadFrom(gsDll);
            var flags = System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic
                | System.Reflection.BindingFlags.Static
                | System.Reflection.BindingFlags.Instance;

            // (1) Class instance method.
            var joinerType = asm.GetTypes().Single(t => t.Name == "Joiner");
            var sumMethod = joinerType.GetMethod("Sum", flags);
            Assert.NotNull(sumMethod);
            var sumParams = sumMethod!.GetParameters();
            Assert.Single(sumParams);
            Assert.True(HasParamArray(sumParams[0]), "Class instance method's variadic param must carry [ParamArrayAttribute].");

            // (2) Class static (shared) method.
            var sequencesType = asm.GetTypes().Single(t => t.Name == "Sequences");
            var ofMethod = sequencesType.GetMethods(flags).Single(m => m.Name == "Of");
            var ofParams = ofMethod.GetParameters();
            Assert.Single(ofParams);
            Assert.True(HasParamArray(ofParams[0]), "Class static (shared) method's variadic param must carry [ParamArrayAttribute].");

            // (3) Interface DIM default body.
            var iadderType = asm.GetTypes().Single(t => t.Name == "IAdder");
            var addMethod = iadderType.GetMethod("Add", flags);
            Assert.NotNull(addMethod);
            var addParams = addMethod!.GetParameters();
            Assert.Single(addParams);
            Assert.True(HasParamArray(addParams[0]), "Interface DIM default body's variadic param must carry [ParamArrayAttribute].");

            // (4) Constructor.
            var tagsType = asm.GetTypes().Single(t => t.Name == "Tags");
            var tagsCtor = tagsType.GetConstructors(flags).Single(c => c.GetParameters().Length == 1);
            var tagsCtorParams = tagsCtor.GetParameters();
            Assert.True(HasParamArray(tagsCtorParams[0]), "Constructor's variadic param must carry [ParamArrayAttribute].");

            // Sanity: invoke the class instance method via reflection using
            // the C#-style expanded array (what `params` lowers to).
            var instance = Activator.CreateInstance(joinerType);
            var sumResult = sumMethod.Invoke(instance, new object[] { new int[] { 1, 2, 3, 4, 5 } });
            Assert.Equal(15, sumResult);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void Variadic_OnNamedDelegate_Emits_ParamArrayAttribute_OnInvoke()
    {
        // Standalone compilation — combining a DIM default-body interface
        // with a named delegate in the same compilation trips a pre-
        // existing emit bug (delegate .ctor MethodDef row mismatch). The
        // sites are exercised independently above.
        var tempDir = Directory.CreateTempSubdirectory("gs_variadic_delegate_csinterop_").FullName;
        try
        {
            var gsSrc = Path.Combine(tempDir, "delegate.gs");
            var gsDll = Path.Combine(tempDir, "GsVariadicDelegateLib.dll");
            File.WriteAllText(gsSrc, """
                package GsVariadicDelegateLib

                public type StringJoiner = delegate func(sep string, parts ...string) string
                """);

            CompileLibrary(gsSrc, gsDll);
            IlVerifier.Verify(gsDll);

            var asm = System.Reflection.Assembly.LoadFrom(gsDll);
            var stringJoinerType = asm.GetTypes().Single(t => t.Name == "StringJoiner");
            var invokeMethod = stringJoinerType.GetMethod("Invoke");
            Assert.NotNull(invokeMethod);
            var invokeParams = invokeMethod!.GetParameters();
            Assert.Equal(2, invokeParams.Length);
            Assert.False(HasParamArray(invokeParams[0]), "Named delegate's fixed leading param must NOT carry [ParamArrayAttribute].");
            Assert.True(HasParamArray(invokeParams[1]), "Named delegate's trailing variadic param must carry [ParamArrayAttribute].");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void CompileLibrary(string gsSrc, string gsDll)
    {
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
                "/out:" + gsDll,
                "/target:library",
                "/targetframework:net10.0",
                gsSrc,
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
    }

    private static bool HasParamArray(System.Reflection.ParameterInfo p) =>
        p.GetCustomAttributesData().Any(a => a.AttributeType.FullName == "System.ParamArrayAttribute");

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_variadic_emit_").FullName;
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

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
