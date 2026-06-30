// <copyright file="Issue1499ClosureConstraintRemapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1499 — when a lambda is reified into a GENERIC synthesized closure /
/// capture-box class (generic over captured enclosing type parameters, per
/// #1477), the cloned closure type parameters must REMAP self-/cross-referential
/// generic constraints onto the clone set. A constraint such as
/// <c>TKey IComparable[TKey]</c> copied onto the closure clone previously still
/// referenced the ORIGINAL <c>TKey</c> (out of scope inside the reified class),
/// so the emitted <c>GenericParamConstraint</c> was unsatisfiable at the capture
/// site (<c>UnsatisfiedMethodParentInst</c>/<c>UnsatisfiedFieldParentInst</c>)
/// and the constrained member call inside the closure's <c>Invoke</c> erased its
/// constraint type argument to <c>object</c>
/// (<c>StackUnexpected [found value 'TKey'][expected ref 'object']</c>).
/// <para>
/// The fix is a two-pass clone in <c>SynthesizedClosureReifier</c> that
/// substitutes the original → clone type-parameter map into every cloned
/// constraint, plus preserving the constrained-call metadata through
/// <c>BoundTreeRewriter.RewriteImportedInstanceCallExpression</c> (which the
/// closure lowering invokes) so the lambda body still binds to the GENERIC
/// interface method (<c>IComparable[T].CompareTo(T)</c>, no box) rather than the
/// non-generic <c>object</c> overload.
/// </para>
/// Each facet ilverifies clean and runs; the controls (unconstrained captured
/// TP, non-generic user-interface constraint) must not regress.
/// </summary>
public class Issue1499ClosureConstraintRemapEmitTests
{
    [Fact]
    public void EndToEnd_SelfReferentialIComparableConstraint_ConstrainedCallInClosure_Runs()
    {
        var source = """
            package Issue1499Cmp
            import System
            class C {
                shared {
                    func Make[TResult, TKey IComparable[TKey]](keySelector (TResult) -> TKey) (TResult, TResult) -> int32 ->
                        (x TResult, y TResult) -> keySelector(x).CompareTo(keySelector(y))
                }
            }
            func Main() {
                let f = C.Make[int32, int32]((v int32) -> v)
                System.Console.WriteLine(f(3, 5))
                System.Console.WriteLine(f(5, 3))
                System.Console.WriteLine(f(4, 4))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("-1\n1\n0\n", output);
    }

    [Fact]
    public void EndToEnd_SelfReferentialIEquatableConstraint_EqualsCallInClosure_Runs()
    {
        var source = """
            package Issue1499Eq
            import System
            class C {
                shared {
                    func Make[TResult, TKey IEquatable[TKey]](keySelector (TResult) -> TKey) (TResult, TResult) -> bool ->
                        (x TResult, y TResult) -> keySelector(x).Equals(keySelector(y))
                }
            }
            func Main() {
                let f = C.Make[int32, int32]((v int32) -> v)
                System.Console.WriteLine(f(4, 4))
                System.Console.WriteLine(f(4, 5))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_TwoCapturedTypeParameters_SecondSelfReferentiallyConstrained_Runs()
    {
        var source = """
            package Issue1499TwoTp
            import System
            class C {
                shared {
                    func Make[T, U IComparable[U]](sel (T) -> U) (T, T) -> int32 ->
                        (a T, b T) -> sel(a).CompareTo(sel(b))
                }
            }
            func Main() {
                let f = C.Make[string, int32]((s string) -> s.Length)
                System.Console.WriteLine(f("aa", "bbbb"))
                System.Console.WriteLine(f("xxxxx", "y"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("-1\n1\n", output);
    }

    [Fact]
    public void EndToEnd_UnconstrainedCapturedTypeParameter_Control_Runs()
    {
        var source = """
            package Issue1499Unconstrained
            import System
            class C {
                shared {
                    func Make[T](item T) () -> T ->
                        () -> item
                }
            }
            func Main() {
                let f = C.Make[int32](77)
                System.Console.WriteLine(f())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("77\n", output);
    }

    [Fact]
    public void EndToEnd_NonGenericUserInterfaceConstraint_Control_Runs()
    {
        var source = """
            package Issue1499NonGenericIface
            import System
            interface ILabeled {
                func Label() string;
            }
            data struct Tag(Name string) : ILabeled {
                func Label() string -> Name
            }
            class C {
                shared {
                    func Make[T ILabeled](item T) () -> string ->
                        () -> item.Label()
                }
            }
            func Main() {
                let t = Tag("hello")
                let f = C.Make[Tag](t)
                System.Console.WriteLine(f())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1499_exe_").FullName;
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
