// <copyright file="Issue1532ObjectToTypeParamCastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1532 — gsc rejected an explicit cast from <c>object</c> (or
/// <c>object?</c>) to a type parameter <c>T</c> — written <c>T(o)</c> — with
/// <c>GS0155: Cannot convert type 'object' to 'T'</c>. C# permits <c>(T)o</c>
/// for ANY type parameter (unconstrained, <c>class</c>-, <c>struct</c>-, or
/// interface/base-constrained) as an explicit reference/unboxing conversion
/// checked at runtime, lowering to <c>unbox.any &lt;T&gt;</c> (a checked
/// reference cast for reference <c>T</c>, an unbox for value <c>T</c>).
/// <para>
/// The fix adds an explicit conversion <c>object -&gt; T</c> in the binder's
/// conversion classifier (regardless of the type parameter's constraints); the
/// emitter already lowered an <c>object</c>/interface → type-parameter
/// conversion to <c>unbox.any T</c>. The conversion is EXPLICIT only — an
/// implicit <c>object -&gt; T</c> still errors — and does not disturb the
/// reverse <c>T -&gt; object</c> erasure rule.
/// </para>
/// Every scenario round-trips gsc → PE → ilverify → dotnet exec. Each uses a
/// UNIQUE package/type name because the in-process <c>FunctionTypeSymbol</c>
/// cache is name-keyed.
/// </summary>
public class Issue1532ObjectToTypeParamCastEmitTests
{
    [Fact]
    public void EndToEnd_UnconstrainedT_BoxedValue_RoundTrips()
    {
        const string source = """
            package i1532unconval
            import System

            func Uncon[T](o object) T { return T(o) }

            func Main() {
                let a object = 42
                Console.WriteLine(Uncon[int32](a))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_UnconstrainedT_Reference_RoundTrips()
    {
        const string source = """
            package i1532unconref
            import System

            func Uncon[T](o object) T { return T(o) }

            func Main() {
                let b object = "hi"
                Console.WriteLine(Uncon[string](b))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void EndToEnd_ClassConstrainedT_Reference_RoundTrips()
    {
        const string source = """
            package i1532classref
            import System

            func RefC[T class](o object) T { return T(o) }

            func Main() {
                let b object = "world"
                Console.WriteLine(RefC[string](b))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("world\n", output);
    }

    [Fact]
    public void EndToEnd_StructConstrainedT_BoxedValue_RoundTrips()
    {
        const string source = """
            package i1532structval
            import System

            func ValC[T struct](o object) T { return T(o) }

            func Main() {
                let a object = 7
                Console.WriteLine(ValC[int32](a))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceConstrainedT_RoundTrips()
    {
        const string source = """
            package i1532iface
            import System

            interface IShape { func Area() int32; }

            struct Sq(S int32) : IShape { func Area() int32 { return S } }

            func IfaceC[T IShape](o object) T { return T(o) }

            func Main() {
                let a object = Sq(5)
                Console.WriteLine(IfaceC[Sq](a).Area())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void EndToEnd_NullableObjectSource_BoxedValue_RoundTrips()
    {
        // `object?` reaches the same explicit conversion via its `object`
        // ClrType; a non-null boxed value unboxes back to the value type.
        const string source = """
            package i1532nullobj
            import System

            func Uncon[T](o object?) T { return T(o) }

            func Main() {
                let a object? = 99
                Console.WriteLine(Uncon[int32](a))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void EndToEnd_DelegateMarshalling_Invoke_RoundTrips()
    {
        // The real Oahu driver: a delegate-marshalling invoker casts each
        // erased `object` argument to the delegate's declared type parameter.
        const string source = """
            package i1532delegate
            import System

            func Invoke[T1, T2](delgat (T1, T2) -> object, p []object) object {
                return delgat(T1(p[0]), T2(p[1]))
            }

            func Add(a int32, b string) object { return a }

            func Main() {
                let ps = []object{50, "x"}
                Console.WriteLine(Invoke[int32, string](Add, ps))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("50\n", output);
    }

    [Fact]
    public void Negative_ImplicitObjectToTypeParam_IsRejected()
    {
        // The new conversion is EXPLICIT only: an implicit `object -> T` (no
        // cast) must still be rejected — C# reports CS0266 ("an explicit
        // conversion exists"), gsc reports the matching GS0156.
        const string source = """
            package i1532negimplicit
            func Bad[T](o object) T { return o }
            """;

        var (exit, stdout, stderr) = TryCompileLibrary(source);
        Assert.True(exit != 0, $"expected compile failure but succeeded.\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.Contains("GS0156", stdout + stderr);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1532_exe_").FullName;
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

    private static (int Exit, string Stdout, string Stderr) TryCompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1532_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:library",
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

            return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
