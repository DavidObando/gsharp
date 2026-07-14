// <copyright file="Issue2338NamedDelegateGenericClosureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2338 follow-up: <c>EmitFunctionLiteralToNamedDelegate</c> (a lambda
/// literal converted to a user-declared NAMED delegate type, e.g.
/// <c>type Getter[T any] = delegate func() T</c>) was missing the same
/// generic-closure-reification handling that its sibling
/// <c>EmitFunctionLiteral</c> already had for issue #1477. When the lambda
/// captured a value whose type referenced an enclosing generic type/method
/// parameter, the synthesized closure became a "reified" (self-instantiated)
/// generic type (per <c>ClosureInfo.ConstructedClassSym</c>), but the
/// named-delegate conversion path still emitted the closure's <c>newobj</c>
/// ctor, capture-field <c>stfld</c>s, and <c>ldftn Invoke</c> against bare
/// cached handles instead of resolving self-instantiation-aware tokens via
/// <c>ResolveUserCtorTokenForDefault</c> / <c>ResolveFieldToken</c> /
/// <c>ResolveClosureInvokeFtnToken</c>. This produced an open-generic token
/// (e.g. <c>Closure&lt;!0&gt;</c>) used inside the closure's own constructed
/// generic body — rejected by ilverify with <c>StackUnexpected</c> (found the
/// open type where the constructed <c>Closure&lt;T0&gt;</c> was expected) and
/// <c>DelegateCtor</c> (unrecognized arguments for delegate <c>.ctor</c>), and
/// a runtime <c>TypeLoadException</c> / <c>BadImageFormatException</c>.
/// <para>
/// The fix mirrors <c>EmitFunctionLiteral</c> exactly: check
/// <c>IsUserGenericTypeReference(closure.ConstructedClassSym)</c> and route
/// the ctor/field/invoke tokens through the same resolvers used for the
/// already-correct inferred-delegate-type closure path.
/// </para>
/// <list type="bullet">
/// <item>Facet A — a generic containing class whose instance method captures
/// <c>this.value</c> (a <c>T</c>-typed field) in a lambda assigned to a named
/// delegate, invoked for both a value-type and a reference-type
/// instantiation.</item>
/// <item>Facet B — a generic FUNCTION (MVAR) whose lambda captures the
/// function's type-parameter-typed parameter and assigns it to a named
/// delegate, invoked for both a value-type and reference-type
/// instantiation.</item>
/// <item>Facet C — a NESTED generic context: a generic method with its own
/// additional type parameter declared inside a generic class, where two
/// lambdas separately capture the class-level type parameter value and the
/// method-level type parameter value, each assigned to the (differently
/// instantiated) named delegate.</item>
/// <item>Facet D — non-generic control: a plain (non-generic) class/function
/// capturing a local in a lambda assigned to a non-generic named delegate —
/// confirms no regression in the common, already-correct case.</item>
/// </list>
/// All facets faulted (ilverify errors / <c>BadImageFormatException</c> at
/// runtime) before the fix and pass (clean ilverify + correct runtime output)
/// after it.
/// </summary>
public class Issue2338NamedDelegateGenericClosureEmitTests
{
    // Facet A: generic containing class, lambda captures `this.value` (a
    // T-typed field), assigned to a named delegate, invoked in the same
    // method — for both a value-type and a reference-type instantiation.
    [Fact]
    public void EndToEnd_FacetA_GenericClassCapturesThisField_NamedDelegate_ValueAndReferenceType_Runs()
    {
        var source = """
            package Cap2338NamedA
            import System

            type Getter2338NamedA[T any] = delegate func() T

            class HolderNamedA2338[T] {
                let value T
                init(value T) { this.value = value }
                func Show() {
                    var g Getter2338NamedA[T] = () -> this.value
                    Console.WriteLine(g.Invoke())
                }
            }

            func Main() {
                var hi = HolderNamedA2338[int32](7)
                hi.Show()
                var hs = HolderNamedA2338[string]("abc")
                hs.Show()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\nabc\n", output);
    }

    // Facet B: generic FUNCTION (MVAR) whose lambda captures the
    // type-parameter-typed parameter and assigns it to a named delegate,
    // invoked inside the same function — for both a value-type and a
    // reference-type instantiation.
    [Fact]
    public void EndToEnd_FacetB_GenericFunctionCapturesTypeParamValue_NamedDelegate_ValueAndReferenceType_Runs()
    {
        var source = """
            package Cap2338NamedB
            import System

            type Getter2338NamedB[T any] = delegate func() T

            func RunGetter2338NamedB[T](item T) {
                var g Getter2338NamedB[T] = () -> item
                Console.WriteLine(g.Invoke())
            }

            func Main() {
                RunGetter2338NamedB[int32](42)
                RunGetter2338NamedB[string]("hi")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\nhi\n", output);
    }

    // Facet C: nested generic context — a generic method with its own
    // additional type parameter declared inside a generic class. Two
    // lambdas separately capture the class-level type-parameter value and
    // the method-level type-parameter value, each assigned to a
    // differently-instantiated named delegate.
    [Fact]
    public void EndToEnd_FacetC_NestedGenericMethodInGenericClass_NamedDelegate_Runs()
    {
        var source = """
            package Cap2338NamedC
            import System

            type Getter2338NamedC[T any] = delegate func() T

            class OuterNamedC2338[T] {
                let outerValue T
                init(outerValue T) { this.outerValue = outerValue }

                func Combine[U](innerValue U) {
                    var showOuter Getter2338NamedC[T] = () -> this.outerValue
                    var showInner Getter2338NamedC[U] = () -> innerValue
                    Console.WriteLine(showOuter.Invoke())
                    Console.WriteLine(showInner.Invoke())
                }
            }

            func Main() {
                var o = OuterNamedC2338[int32](10)
                o.Combine[string]("nested")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\nnested\n", output);
    }

    // Facet D: non-generic control — a plain (non-generic) lambda capturing
    // a local, assigned to a non-generic named delegate. Confirms the fix
    // does not disturb the already-correct common case.
    [Fact]
    public void EndToEnd_FacetD_NonGenericControl_NamedDelegate_Runs()
    {
        var source = """
            package Cap2338NamedD
            import System

            type Getter2338NamedD[T any] = delegate func() T

            func Main() {
                var captured = 99
                var g Getter2338NamedD[int32] = () -> captured
                Console.WriteLine(g.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2338_named_exe_").FullName;
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
