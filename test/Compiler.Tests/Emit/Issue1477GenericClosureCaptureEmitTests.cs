// <copyright file="Issue1477GenericClosureCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1477 — a lambda declared inside a generic type (or generic method)
/// that captures a value whose type references an enclosing generic
/// type/method parameter (a <c>T</c>-typed parameter/local, <c>this</c> of
/// <c>G[T]</c>, or a boxed <c>Box[T]</c>) used to emit a NON-generic
/// synthesized display / capture-box class. Its capture field was then typed
/// <c>!0</c> with no generic parameter in scope — an illegal field type that
/// faulted at load (<c>System.TypeLoadException</c>) and produced unverifiable
/// IL (<c>StackUnexpected</c> at the capture store + <c>DelegateCtor</c> at the
/// delegate construction). The fix reifies the synthesized class generic over
/// exactly the referenced enclosing parameters (Roslyn semantics) and parents
/// the capture-site <c>newobj</c> / field stores / <c>ldftn Invoke</c> at the
/// constructed display-class TypeSpec.
/// <list type="bullet">
/// <item>Facet A — a generic static factory whose lambda captures a
/// <c>T</c>-typed parameter, value-type instantiation (<c>Op[int]</c>).</item>
/// <item>Facet B — the same shape with a reference-type instantiation
/// (<c>Op[string]</c>).</item>
/// <item>Facet C — a lambda capturing <c>this</c> / an instance field of
/// <c>G[T]</c> (mirrors <c>Mp4Operation`1.SetContinuation</c>).</item>
/// <item>Facet D — a generic METHOD (MVAR) whose lambda captures the method's
/// type-parameter-typed local.</item>
/// </list>
/// All four faulted on current main and pass (clean ilverify + correct runtime
/// output) after the fix.
/// </summary>
public class Issue1477GenericClosureCaptureEmitTests
{
    [Fact]
    public void EndToEnd_FacetA_GenericFactoryCapturesTypeParamValue_ValueType_Runs()
    {
        var source = """
            package Cap1477A
            import System
            import System.Threading.Tasks

            open class OpA[T] {
                private let cf (Task) -> T
                init(cf (Task) -> T) { this.cf = cf }
                func Run(t Task) T -> cf(t)
                shared {
                    func FromCompleted(result T) OpA[T] -> OpA[T]((_ Task) -> result)
                }
            }

            func Main() {
                let o = OpA[int].FromCompleted(5)
                Console.WriteLine(o.Run(Task.CompletedTask))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void EndToEnd_FacetB_GenericFactoryCapturesTypeParamValue_ReferenceType_Runs()
    {
        var source = """
            package Cap1477B
            import System
            import System.Threading.Tasks

            open class OpB[T] {
                private let cf (Task) -> T
                init(cf (Task) -> T) { this.cf = cf }
                func Run(t Task) T -> cf(t)
                shared {
                    func FromCompleted(result T) OpB[T] -> OpB[T]((_ Task) -> result)
                }
            }

            func Main() {
                let o = OpB[string].FromCompleted("hello")
                Console.WriteLine(o.Run(Task.CompletedTask))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void EndToEnd_FacetC_LambdaCapturesThisOfGenericType_Runs()
    {
        var source = """
            package Cap1477C
            import System

            open class HolderC[T] {
                let value T
                init(value T) { this.value = value }
                func MakeGetter() () -> T -> () -> this.value
            }

            func Main() {
                let h = HolderC[int](42)
                let g = h.MakeGetter()
                Console.WriteLine(g())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_FacetD_GenericMethodLambdaCapturesMethodTypeParamLocal_Runs()
    {
        var source = """
            package Cap1477D
            import System

            class UtilD {
                shared {
                    func MakeGetter[U](item U) () -> U {
                        let local = item
                        return () -> local
                    }
                }
            }

            func Main() {
                let g = UtilD.MakeGetter[int](99)
                Console.WriteLine(g())
                let gs = UtilD.MakeGetter[string]("world")
                Console.WriteLine(gs())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\nworld\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1477_exe_").FullName;
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
