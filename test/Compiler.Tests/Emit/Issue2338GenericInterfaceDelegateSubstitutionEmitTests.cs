// <copyright file="Issue2338GenericInterfaceDelegateSubstitutionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2338 follow-up: the remaining <c>InterfaceSymbol.SubstituteType</c>
/// gap for generic interface methods/properties whose return or parameter
/// type is a named delegate (or a plain generic struct/class) constructed
/// over the interface's own type parameter or the method's own generic
/// parameter.
/// <para>
/// Note: issue #2230 (fixed by PR #2249) covered the IMPORTED-CLR interface
/// path — a distinct symbol/binding path from the source-interface
/// (<c>InterfaceSymbol</c>) gap fixed here; the two are not conflated.
/// </para>
/// <para>
/// Root causes (three independent, compounding gaps, all in the
/// source-interface implementation-matching path):
/// <list type="number">
/// <item><c>InterfaceSymbol.SubstituteType</c> (the construction-time member
/// substitution helper used by <c>TryResolveMembers</c>/<c>SubstituteMethod</c>
/// when building a CONSTRUCTED generic interface's methods, e.g.
/// <c>IFactory[int32]</c>) had no case for <c>DelegateTypeSymbol</c> nor
/// <c>StructSymbol</c>. A constructed interface's method kept exposing the
/// still-open definition type (e.g. <c>Getter[T]</c> / <c>Box[T]</c>) instead
/// of the closed instantiation (<c>Getter[int32]</c> / <c>Box[int32]</c>),
/// which made <c>DeclarationBinder</c>'s interface-implementation signature
/// matching reject a genuinely correct implementation with a false-negative
/// <c>GS0187</c> ("does not implement interface method"). The fix mirrors the
/// existing <c>DelegateTypeSymbol</c>/<c>StructSymbol</c> branches already
/// present in <c>Binder.SubstituteType</c> and
/// <c>StructSymbol.SubstituteTypeForConstruction</c>.</item>
/// <item><c>InterfaceSymbol.SubstituteMethod</c> never copied the original
/// interface method's own (method-level) generic type parameters onto the
/// constructed method, so a generic method (e.g. <c>func Transform[TOut](...)</c>)
/// declared on a CONSTRUCTED generic interface silently lost its arity
/// (defaulting to none). This made
/// <c>DeclarationBinder.TryBuildMethodTypeParameterMap</c> see a bogus
/// interface-vs-implementer arity mismatch and reject the candidate before
/// signature comparison ever ran — reachable only once gap 1 stopped masking
/// it. Fixed by copying <c>m.TypeParameters</c> onto the substituted method.</item>
/// <item><c>DeclarationBinder.TypeSignaturesEquivalent</c> had no case for
/// <c>DelegateTypeSymbol</c>, so a named delegate constructed over a
/// METHOD-level generic parameter (not fixed by substituting the interface's
/// own type arguments, since it is the method's own type parameter that
/// differs between the interface's declared signature and the implementer's)
/// still failed to compare as structurally equivalent. Fixed by adding a
/// <c>DelegateTypeSymbol</c> branch mirroring the existing
/// <c>StructSymbol</c>/<c>InterfaceSymbol</c> branches (recursing through
/// <c>TypeArgumentsEquivalent</c> so the method-type-parameter map applies).</item>
/// </list>
/// </para>
/// Negative/control coverage confirms genuine signature mismatches (wrong
/// type argument, a different named delegate entirely, a real generic-arity
/// mismatch) are still correctly rejected with <c>GS0187</c> — the fix only
/// stops FALSE-negative rejections, it does not loosen matching.
/// <para>See also <c>Issue2338GenericInterfaceDelegateSubstitutionTests</c>
/// (Core.Tests) for pure-binder-level coverage of the same fixes.</para>
/// </summary>
public class Issue2338GenericInterfaceDelegateSubstitutionEmitTests
{
    [Fact]
    public void Facet1_InterfaceLevelGenericDelegateReturn_ValueAndReferenceType_Runs()
    {
        var source = """
            package Cap2338IfaceReturn
            import System

            type Getter2338IfaceReturn[T any] = delegate func() T

            interface IFactory2338IfaceReturn[T any] {
                func Make() Getter2338IfaceReturn[T];
            }

            class ConcreteInt2338IfaceReturn : IFactory2338IfaceReturn[int32] {
                func Make() Getter2338IfaceReturn[int32] {
                    return () -> 42
                }
            }

            class ConcreteStr2338IfaceReturn : IFactory2338IfaceReturn[string] {
                func Make() Getter2338IfaceReturn[string] {
                    return () -> "hi"
                }
            }

            func Main() {
                var ci = ConcreteInt2338IfaceReturn()
                Console.WriteLine(ci.Make().Invoke())
                var cs = ConcreteStr2338IfaceReturn()
                Console.WriteLine(cs.Make().Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\nhi\n", output);
    }

    [Fact]
    public void Facet2_InterfaceLevelGenericDelegateParameter_Runs()
    {
        var source = """
            package Cap2338IfaceParam
            import System

            type Consumer2338IfaceParam[T any] = delegate func(item T) void

            interface ISink2338IfaceParam[T any] {
                func Accept(c Consumer2338IfaceParam[T]) void;
            }

            class ConcreteSink2338IfaceParam : ISink2338IfaceParam[int32] {
                func Accept(c Consumer2338IfaceParam[int32]) void {
                    c.Invoke(99)
                }
            }

            func Main() {
                var s = ConcreteSink2338IfaceParam()
                s.Accept(func(x int32) void {
                    Console.WriteLine(x)
                })
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void Facet3_InterfaceLevelGenericPlainClassReturn_Runs()
    {
        var source = """
            package Cap2338IfaceClass
            import System

            class Box2338IfaceClass[T any](Value T)

            interface IFactory2338IfaceClass[T any] {
                func Make() Box2338IfaceClass[T];
            }

            class Concrete2338IfaceClass : IFactory2338IfaceClass[int32] {
                func Make() Box2338IfaceClass[int32] {
                    return Box2338IfaceClass[int32](7)
                }
            }

            func Main() {
                var c = Concrete2338IfaceClass()
                Console.WriteLine(c.Make().Value)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void Facet4_MethodLevelGenericDelegateOnNonGenericInterface_ValueAndReferenceType_Runs()
    {
        var source = """
            package Cap2338MethodLevel
            import System

            type Getter2338MethodLevel[T any] = delegate func() T

            interface IFactory2338MethodLevel {
                func Make[T](seed T) Getter2338MethodLevel[T];
            }

            class Concrete2338MethodLevel : IFactory2338MethodLevel {
                func Make[T](seed T) Getter2338MethodLevel[T] {
                    return () -> seed
                }
            }

            func Main() {
                var c = Concrete2338MethodLevel()
                Console.WriteLine(c.Make[int32](55).Invoke())
                Console.WriteLine(c.Make[string]("world").Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("55\nworld\n", output);
    }

    [Fact]
    public void Facet5_CombinedInterfaceAndMethodLevelGenericsOverMultiParamDelegate_Runs()
    {
        var source = """
            package Cap2338Combined
            import System

            type Combiner2338Combined[A any, B any] = delegate func(item A) B

            interface ITransformer2338Combined[TIn any] {
                func Transform[TOut](conv Combiner2338Combined[TIn, TOut]) TOut;
            }

            class Concrete2338Combined : ITransformer2338Combined[int32] {
                func Transform[TOut](conv Combiner2338Combined[int32, TOut]) TOut {
                    return conv.Invoke(10)
                }
            }

            func Main() {
                var c = Concrete2338Combined()
                var result = c.Transform[string](func(x int32) string {
                    return "n=" + x.ToString()
                })
                Console.WriteLine(result)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("n=10\n", output);
    }

    [Fact]
    public void Facet6_ContainingTypeGenericClassImplementingGenericInterfaceOverCombinedGenericDelegate_Runs()
    {
        // Containing-type generics: the implementing class is itself generic
        // (class-level TIn is not yet a concrete type at the class
        // declaration site) combined with a method-level type parameter
        // (TOut) inside the same delegate signature.
        var source = """
            package Cap2338Containing
            import System

            type Combiner2338Containing[A any, B any] = delegate func(item A) B

            interface ITransformer2338Containing[TIn any] {
                func Transform[TOut](conv Combiner2338Containing[TIn, TOut]) TOut;
            }

            class GenericConcrete2338Containing[TIn any](Seed TIn) : ITransformer2338Containing[TIn] {
                func Transform[TOut](conv Combiner2338Containing[TIn, TOut]) TOut {
                    return conv.Invoke(Seed)
                }
            }

            func Main() {
                var c = GenericConcrete2338Containing[int32](21)
                var result = c.Transform[string](func(x int32) string {
                    return "n=" + x.ToString()
                })
                Console.WriteLine(result)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("n=21\n", output);
    }

    [Fact]
    public void Facet7_NestedGenericDelegateSignature_Runs()
    {
        // The delegate's own type argument is itself a constructed generic
        // class over the interface's type parameter: Getter[Box[T]].
        var source = """
            package Cap2338Nested
            import System

            class Box2338Nested[T any](Value T)
            type Getter2338Nested[T any] = delegate func() T

            interface IFactory2338Nested[T any] {
                func Make() Getter2338Nested[Box2338Nested[T]];
            }

            class Concrete2338Nested : IFactory2338Nested[int32] {
                func Make() Getter2338Nested[Box2338Nested[int32]] {
                    return () -> Box2338Nested[int32](123)
                }
            }

            func Main() {
                var c = Concrete2338Nested()
                Console.WriteLine(c.Make().Invoke().Value)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("123\n", output);
    }

    // Non-generic control: confirms the fix does not disturb the
    // already-correct common (non-generic-interface) case.
    [Fact]
    public void Facet8_NonGenericInterfaceControl_Runs()
    {
        var source = """
            package Cap2338Control
            import System

            type Getter2338Control = delegate func() int32

            interface IFactory2338Control {
                func Make() Getter2338Control;
            }

            class Concrete2338Control : IFactory2338Control {
                func Make() Getter2338Control {
                    return () -> 13
                }
            }

            func Main() {
                var c = Concrete2338Control()
                Console.WriteLine(c.Make().Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("13\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2338_iface_delegate_exe_").FullName;
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
