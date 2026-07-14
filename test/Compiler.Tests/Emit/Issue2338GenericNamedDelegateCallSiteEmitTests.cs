// <copyright file="Issue2338GenericNamedDelegateCallSiteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2338 follow-up (root cause of the "generic named-delegate call-site
/// defect" discovered while testing <c>EmitFunctionLiteralToNamedDelegate</c>):
/// calling a generic G# user function/method whose parameter or return type is
/// a NAMED delegate (<c>type Getter[T any] = delegate func() T</c>) constructed
/// over the callee's OWN type parameter produced a <em>caller-side</em> type
/// mismatch, independent of any closure/capture.
/// <para>
/// Root cause: <c>Binder.SubstituteType</c> — the substitution routine
/// <see cref="GSharp.Core.CodeAnalysis.Binding.OverloadResolver"/> uses to
/// compute a generic call's substituted parameter/return types (for source
/// functions, methods, and extension methods alike, both instance and shared)
/// — had no case for <c>DelegateTypeSymbol</c>, unlike its sibling
/// <c>StructSymbol.SubstituteTypeForConstruction</c> which already substitutes
/// through a constructed named delegate's type arguments (issue #1503). A
/// call like <c>func MakeGetter[T](item T) Getter[T]</c> therefore bound with
/// its ORIGINAL (still-open, <c>Getter&lt;T&gt;</c>) return type even when
/// instantiated over a concrete argument, instead of the substituted
/// <c>Getter&lt;int32&gt;</c>. The emitter's <c>MethodSpec</c> for the call
/// itself was always correct (built directly from the substitution
/// dictionary), so the actual value produced on the stack was the correctly
/// closed <c>Getter&lt;int32&gt;</c> — but the caller's declared local
/// variable / subsequent-use type (derived from the wrong, still-open binder
/// type) disagreed, failing ilverify with <c>StackUnexpected</c> ("found ref
/// Getter&lt;int32&gt;, expected ref Getter&lt;!!0&gt;") or, in some binding
/// shapes, rejecting the call outright at compile time with a spurious
/// <c>GS0155</c> conversion diagnostic.
/// </para>
/// <para>
/// The fix adds a <c>DelegateTypeSymbol</c> branch to
/// <c>Binder.SubstituteType</c> mirroring the existing
/// <c>StructSymbol.SubstituteTypeForConstruction</c> branch exactly. Because
/// <c>Binder.SubstituteType</c> is the single shared primitive threaded
/// through every generic call-binding path (free functions, instance/shared
/// methods, and extension methods), the fix applies uniformly without
/// special-casing any one call shape.
/// </para>
/// <list type="bullet">
/// <item>Facet 1 — RETURN position: a generic free function constructs and
/// returns a named delegate closed over its own type parameter, for both a
/// value-type and a reference-type instantiation.</item>
/// <item>Facet 2 — PARAMETER + ROUND-TRIP: a generic free function takes a
/// named delegate parameter (closed over its own type parameter) and returns
/// it unchanged (identity), exercising both the parameter conversion and the
/// return-type substitution together.</item>
/// <item>Facet 3 — METHOD-LEVEL generics: a non-generic class's instance
/// method carries its OWN type parameter and returns a named delegate closed
/// over it, called for both a value-type and a reference-type instantiation.</item>
/// <item>Facet 4 — CONTAINING-TYPE generics: a generic class's instance method
/// (no method-level type parameter of its own) returns a named delegate closed
/// over the class's type parameter, called on both a value-type and a
/// reference-type instantiation of the class.</item>
/// <item>Facet 5 — SHARED (static) method on a generic class returns a named
/// delegate closed over the class's type parameter.</item>
/// <item>Facet 6 — CHAINED generic calls: a generic function calls another
/// generic function and forwards its named-delegate return value, for both a
/// value-type and a reference-type instantiation.</item>
/// <item>Facet 7 — multi-type-parameter named delegate: a two-type-parameter
/// delegate constructed from a lambda argument (parameter-side unification)
/// and returned (return-side substitution) together.</item>
/// <item>Facet 8 — non-generic control: a plain function returning a
/// non-generic named delegate, confirming no regression in the common case.</item>
/// </list>
/// Every generic facet faulted (ilverify <c>StackUnexpected</c> or a spurious
/// <c>GS0155</c> compile error) before the fix and passes (clean ilverify +
/// correct runtime output) after it; each was independently confirmed against
/// the reverted fix.
/// </summary>
public class Issue2338GenericNamedDelegateCallSiteEmitTests
{
    [Fact]
    public void Facet1_ReturnPosition_GenericFunctionReturnsDelegateOverOwnTypeParam_ValueAndReferenceType_Runs()
    {
        var source = """
            package Cap2338CsReturn
            import System

            type Getter2338CsReturn[T any] = delegate func() T

            func MakeGetter2338CsReturn[T](item T) Getter2338CsReturn[T] {
                return () -> item
            }

            func Main() {
                var g = MakeGetter2338CsReturn[int32](42)
                Console.WriteLine(g.Invoke())
                var gs = MakeGetter2338CsReturn[string]("hi")
                Console.WriteLine(gs.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\nhi\n", output);
    }

    [Fact]
    public void Facet2_ParameterAndReturnRoundTrip_GenericFunctionTakesAndReturnsSameDelegateType_Runs()
    {
        var source = """
            package Cap2338CsRoundTrip
            import System

            type Getter2338CsRoundTrip[T any] = delegate func() T

            func RoundTrip2338Cs[T](g Getter2338CsRoundTrip[T]) Getter2338CsRoundTrip[T] {
                return g
            }

            func Main() {
                var src Getter2338CsRoundTrip[int32] = func() int32 { return 7 }
                var g = RoundTrip2338Cs[int32](src)
                Console.WriteLine(g.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void Facet3_MethodLevelGenerics_InstanceMethodWithOwnTypeParameter_NonGenericClass_Runs()
    {
        var source = """
            package Cap2338CsMethodLevel
            import System

            type Getter2338CsMethodLevel[T any] = delegate func() T

            class Utils2338CsMethodLevel {
                func Wrap[T](item T) Getter2338CsMethodLevel[T] {
                    return () -> item
                }
            }

            func Main() {
                var u = Utils2338CsMethodLevel()
                var g = u.Wrap[int32](11)
                Console.WriteLine(g.Invoke())
                var gs = u.Wrap[string]("method")
                Console.WriteLine(gs.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\nmethod\n", output);
    }

    [Fact]
    public void Facet4_ContainingTypeGenerics_InstanceMethodReturnsDelegateOverClassTypeParam_ValueAndReferenceType_Runs()
    {
        var source = """
            package Cap2338CsContainingType
            import System

            type Getter2338CsContainingType[T any] = delegate func() T

            open class Holder2338CsContainingType[T] {
                let value T
                init(value T) { this.value = value }
                func MakeGetter() Getter2338CsContainingType[T] {
                    return () -> this.value
                }
            }

            func Main() {
                var hi = Holder2338CsContainingType[int32](42)
                Console.WriteLine(hi.MakeGetter().Invoke())
                var hs = Holder2338CsContainingType[string]("abc")
                Console.WriteLine(hs.MakeGetter().Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\nabc\n", output);
    }

    [Fact]
    public void Facet5_SharedStaticMethod_GenericClass_ReturnsDelegateOverClassTypeParam_Runs()
    {
        var source = """
            package Cap2338CsShared
            import System

            type Getter2338CsShared[T any] = delegate func() T

            class Factory2338CsShared[T] {
                shared {
                    func Make(value T) Getter2338CsShared[T] {
                        return () -> value
                    }
                }
            }

            func Main() {
                var g = Factory2338CsShared[int32].Make(99)
                Console.WriteLine(g.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void Facet6_ChainedGenericCalls_NestedGenericFunctionForwardsDelegateReturn_ValueAndReferenceType_Runs()
    {
        var source = """
            package Cap2338CsChain
            import System

            type Getter2338CsChain[T any] = delegate func() T

            func MakeGetter2338CsChain[T](item T) Getter2338CsChain[T] {
                return () -> item
            }

            func Relay2338CsChain[U](item U) Getter2338CsChain[U] {
                return MakeGetter2338CsChain[U](item)
            }

            func Main() {
                var g = Relay2338CsChain[int32](55)
                Console.WriteLine(g.Invoke())
                var gs = Relay2338CsChain[string]("chained")
                Console.WriteLine(gs.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("55\nchained\n", output);
    }

    [Fact]
    public void Facet7_MultiTypeParamDelegate_LambdaArgumentUnificationAndReturn_Runs()
    {
        var source = """
            package Cap2338CsMulti
            import System

            type Conv2338CsMulti[TIn any, TOut any] = delegate func(x TIn) TOut

            func MakeConv2338CsMulti[TIn, TOut](fn (TIn) -> TOut) Conv2338CsMulti[TIn, TOut] {
                return (x TIn) -> fn(x)
            }

            func Main() {
                var c = MakeConv2338CsMulti[int32, string]((x int32) -> "n=" + x.ToString())
                Console.WriteLine(c.Invoke(7))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("n=7\n", output);
    }

    // Non-generic control: confirms the fix does not disturb the
    // already-correct common (non-generic) case.
    [Fact]
    public void Facet8_NonGenericControl_PlainFunctionReturnsNonGenericDelegate_Runs()
    {
        var source = """
            package Cap2338CsControl
            import System

            type Getter2338CsControl = delegate func() int32

            func MakeGetter2338CsControl(item int32) Getter2338CsControl {
                return () -> item
            }

            func Main() {
                var g = MakeGetter2338CsControl(13)
                Console.WriteLine(g.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("13\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2338_callsite_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
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
