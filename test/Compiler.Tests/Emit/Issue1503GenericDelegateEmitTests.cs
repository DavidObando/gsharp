// <copyright file="Issue1503GenericDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1503 / ADR-0059 follow-up: end-to-end emit tests for GENERIC named
/// delegate type declarations (<c>type Predicate[T any] = delegate func(value T) bool</c>).
/// The emitter mangles the delegate TypeDef name with the backtick-arity
/// suffix, threads one <c>GenericParam</c> row per type parameter, and
/// references the slots as <c>VAR(idx)</c> in the <c>Invoke</c>/<c>.ctor</c>
/// signatures — reusing the existing generic struct/class/interface emit
/// mechanism. Constructed instantiations (<c>Predicate[int32]</c>) are built
/// from a lambda/method group and invoked through a <c>MemberRef</c> parented
/// at the delegate <c>TypeSpec</c>.
/// <para>
/// Every type/func/package is given a unique name because the
/// <c>FunctionTypeSymbol</c> cache is not cleared between in-process tests.
/// </para>
/// </summary>
public class Issue1503GenericDelegateEmitTests
{
    // (a) declare + construct (from a lambda) + invoke a single-type-param
    // generic delegate over a concrete type argument; assert the result.
    [Fact]
    public void SingleTypeParam_ConstructFromLambda_AndInvoke_Runs()
    {
        var source = """
            package Gen1503Single
            import System

            type Pred1503S[T any] = delegate func(value T) bool

            func Main() {
                var isPositive Pred1503S[int32] = func(value int32) bool {
                    return value > 0
                }
                Console.WriteLine(isPositive.Invoke(7))
                Console.WriteLine(isPositive.Invoke(-3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    // (a') construct the same generic delegate from a METHOD GROUP (not a
    // lambda) and invoke it.
    [Fact]
    public void SingleTypeParam_ConstructFromMethodGroup_AndInvoke_Runs()
    {
        var source = """
            package Gen1503MethodGroup
            import System

            type Pred1503MG[T any] = delegate func(value T) bool

            func IsEven(value int32) bool {
                return value % 2 == 0
            }

            func Main() {
                var p Pred1503MG[int32] = IsEven
                Console.WriteLine(p.Invoke(4))
                Console.WriteLine(p.Invoke(5))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    // (b) a multi-type-param generic delegate (Converter[TIn, TOut]) — the type
    // parameter appears in both parameter and return position.
    [Fact]
    public void MultiTypeParam_Converter_ConstructAndInvoke_Runs()
    {
        var source = """
            package Gen1503Converter
            import System

            type Conv1503[TIn any, TOut any] = delegate func(x TIn) TOut

            func Main() {
                var toStr Conv1503[int32, string] = func(x int32) string {
                    return "n=" + x.ToString()
                }
                Console.WriteLine(toStr.Invoke(42))

                var toLen Conv1503[string, int32] = func(s string) int32 {
                    return s.Length
                }
                Console.WriteLine(toLen.Invoke("hello"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("n=42\n5\n", output);
    }

    // (c) the type parameter is used in a COMPOSITE parameter/return type
    // (`[]T` in both positions, plus `T` in return position).
    [Fact]
    public void CompositeTypeParam_SliceParamAndReturn_Runs()
    {
        var source = """
            package Gen1503Composite
            import System

            type Mapper1503[T any] = delegate func(items []T) []T
            type Folder1503[T any] = delegate func(items []T) T

            func Main() {
                var passthrough Mapper1503[int32] = func(items []int32) []int32 {
                    return items
                }
                let mapped = passthrough.Invoke([]int32{1, 2, 3})
                Console.WriteLine(mapped[2])

                var firstOf Folder1503[string] = func(items []string) string {
                    return items[0]
                }
                Console.WriteLine(firstOf.Invoke([]string{"a", "b", "c"}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\na\n", output);
    }

    // (d) using the generic delegate as a FIELD, PARAMETER, and LOCAL type.
    [Fact]
    public void GenericDelegate_AsFieldParameterAndLocal_Runs()
    {
        var source = """
            package Gen1503Usage
            import System

            type Op1503[T any] = delegate func(a T, b T) T

            class Calculator1503 {
                var combine Op1503[int32]

                init(op Op1503[int32]) {
                    this.combine = op
                }

                func Apply(a int32, b int32) int32 {
                    return this.combine.Invoke(a, b)
                }
            }

            func RunWith(op Op1503[int32], a int32, b int32) int32 {
                return op.Invoke(a, b)
            }

            func Main() {
                var add Op1503[int32] = func(a int32, b int32) int32 {
                    return a + b
                }
                let calc = Calculator1503(add)
                Console.WriteLine(calc.Apply(20, 22))
                Console.WriteLine(RunWith(add, 3, 4))

                var mul Op1503[int32] = func(a int32, b int32) int32 {
                    return a * b
                }
                Console.WriteLine(RunWith(mul, 6, 7))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n7\n42\n", output);
    }

    // (e) regression: a NON-generic named delegate still emits and behaves
    // unchanged when declared alongside generic ones.
    [Fact]
    public void NonGenericNamedDelegate_StillRunsUnchanged()
    {
        var source = """
            package Gen1503Regression
            import System

            type IntCombine1503 = delegate func(a int32, b int32) int32
            type Pred1503R[T any] = delegate func(value T) bool

            func Main() {
                var sum IntCombine1503 = func(a int32, b int32) int32 {
                    return a + b
                }
                Console.WriteLine(sum.Invoke(2, 40))

                var nonEmpty Pred1503R[string] = func(value string) bool {
                    return value.Length > 0
                }
                Console.WriteLine(nonEmpty.Invoke("x"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\nTrue\n", output);
    }

    // Metadata: the generic delegate emits a verifiable generic TypeDef
    // deriving from System.MulticastDelegate with the type parameter threaded
    // through the Invoke signature.
    [Fact]
    public void GenericDelegate_EmitsGenericMulticastDelegateTypeDef()
    {
        var source = """
            package Gen1503Meta

            type Pred1503Meta[T any] = delegate func(value T) bool
            """;

        var assembly = CompileToLibrary(source);
        var pred = assembly.GetTypes().Single(t => t.Name.StartsWith("Pred1503Meta", StringComparison.Ordinal));

        Assert.True(pred.IsGenericTypeDefinition, $"{pred.Name} should be a generic type definition");
        Assert.Single(pred.GetGenericArguments());
        Assert.True(pred.IsSealed, $"{pred.Name} should be sealed");
        Assert.True(pred.IsClass, $"{pred.Name} should be a class");
        Assert.Equal("System.MulticastDelegate", pred.BaseType!.FullName);

        var invoke = pred.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(invoke);
        Assert.True(invoke!.IsVirtual);
        Assert.False(invoke.IsAbstract);

        var implFlags = invoke.GetMethodImplementationFlags();
        Assert.True(
            (implFlags & MethodImplAttributes.Runtime) == MethodImplAttributes.Runtime,
            "Delegate Invoke must have MethodImplAttributes.Runtime");

        Assert.Equal(typeof(bool), invoke.ReturnType);
        var invokeParams = invoke.GetParameters();
        Assert.Single(invokeParams);

        // The single Invoke parameter must reference the delegate's own type
        // parameter (VAR(0)), not a concrete type.
        var paramType = invokeParams[0].ParameterType;
        Assert.True(paramType.IsGenericParameter, "Invoke parameter should be the delegate's type parameter");
        Assert.Equal(0, paramType.GenericParameterPosition);

        // The runtime delegate ctor remains (object, native int).
        var ctor = pred.GetConstructors(BindingFlags.Public | BindingFlags.Instance).Single();
        var ctorParams = ctor.GetParameters();
        Assert.Equal(2, ctorParams.Length);
        Assert.Equal(typeof(object), ctorParams[0].ParameterType);
        Assert.Equal(typeof(nint), ctorParams[1].ParameterType);
    }

    // Metadata: a multi-type-param generic delegate mangles to `Conv`2` with
    // two generic arguments, and the type parameters land in the right
    // positions on Invoke.
    [Fact]
    public void MultiTypeParam_EmitsArity2TypeDef()
    {
        var source = """
            package Gen1503MetaConv

            type Conv1503Meta[TIn any, TOut any] = delegate func(x TIn) TOut
            """;

        var assembly = CompileToLibrary(source);
        var conv = assembly.GetTypes().Single(t => t.Name.StartsWith("Conv1503Meta", StringComparison.Ordinal));

        Assert.True(conv.IsGenericTypeDefinition);
        Assert.Equal(2, conv.GetGenericArguments().Length);
        Assert.Equal("Conv1503Meta`2", conv.Name);

        var invoke = conv.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance)!;
        var paramType = invoke.GetParameters().Single().ParameterType;
        Assert.True(paramType.IsGenericParameter);
        Assert.Equal(0, paramType.GenericParameterPosition);

        Assert.True(invoke.ReturnType.IsGenericParameter);
        Assert.Equal(1, invoke.ReturnType.GenericParameterPosition);
    }

    private static Assembly CompileToLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1503_lib_").FullName;
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
                    "/target:library",
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

            return Assembly.Load(File.ReadAllBytes(outPath));
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1503_exe_").FullName;
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

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
