// <copyright file="Issue1522StackAllocArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1522 — a <c>stackalloc [n]T</c> used as a METHOD/CONSTRUCTOR ARGUMENT
/// (or any operand evaluated with a non-empty evaluation stack) emitted its CIL
/// <c>localloc</c> INLINE while the receiver and/or previously-evaluated
/// arguments were still on the stack. ECMA-335 III.3.47 requires the stack to be
/// empty (except the size item) at <c>localloc</c>, so ilverify reported
/// <c>LocallocStackNotEmpty</c> (plus a paired <c>Unverifiable</c> at the same
/// offset). The JIT accepted it, but the IL was invalid.
/// <para>
/// The fix spills every non-statement-root <c>stackalloc</c> to a pre-allocated
/// result local: the method-body planner reserves a result-typed slot
/// (<c>Span&lt;T&gt;</c> for the safe form, <c>T*</c>/<c>void*</c> for the
/// pointer form) and the emitter materialises the <c>localloc</c> into that
/// local at an empty-stack point (statement start, in source order) before
/// loading it at the original operand position.
/// </para>
/// A residual bare <c>Unverifiable</c> on the <c>localloc</c> instruction itself
/// is by-design (localloc is valid-but-never-verifiable, see ADR-0124) and is
/// the ONLY tolerated code — <c>LocallocStackNotEmpty</c> is NOT ignored, so a
/// regression re-fails the gate. Each test uses a UNIQUE package/type name
/// because the in-process <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1522StackAllocArgEmitTests
{
    // Only the inherent `localloc` Unverifiable is tolerated. LocallocStackNotEmpty
    // is deliberately NOT ignored so this gate still catches the original bug.
    private static readonly string[] LocallocIlVerifyIgnored =
    {
        "Unverifiable",
    };

    [Fact]
    public void InstanceMethodArgument_SpillsStackAlloc_VerifiesAndRuns()
    {
        // The repro from the issue: an instance-method call whose receiver is on
        // the stack when the stackalloc argument is evaluated.
        const string source = """
            package i1522instance
            import System

            class Sink1522Inst { func Take(s Span[uint8]) int32 -> s.Length }

            func Use(sink Sink1522Inst) int32 { return sink.Take(stackalloc [2]uint8) }

            func Main() { Console.WriteLine(Use(Sink1522Inst())) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void StaticMethodSecondArgument_SpillsStackAlloc_VerifiesAndRuns()
    {
        // A static method's 2nd argument: the first argument (10) is already on
        // the stack when the stackalloc is evaluated.
        const string source = """
            package i1522static
            import System

            func Foo1522(a int32, s Span[uint8]) int32 -> a + s.Length

            func Use() int32 { return Foo1522(10, stackalloc [2]uint8) }

            func Main() { Console.WriteLine(Use()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n", output);
    }

    [Fact]
    public void ConstructorArgument_SpillsStackAlloc_VerifiesAndRuns()
    {
        // A constructor argument (the newobj is pending on the eval stack).
        const string source = """
            package i1522ctor
            import System

            class Thing1522 {
                var N int32 = 0
                init(s Span[uint8]) { N = s.Length }
            }

            func Use() int32 {
                var t = Thing1522(stackalloc [3]uint8)
                return t.N
            }

            func Main() { Console.WriteLine(Use()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void StatementPositionStackAlloc_StillVerifiesAndRuns()
    {
        // Regression guard: a statement-root `var x = stackalloc …` is NOT
        // spilled (it already emits at an empty stack) and keeps working.
        const string source = """
            package i1522stmt
            import System

            func Use() int32 {
                var buf = stackalloc [4]uint8
                buf[0] = uint8(1)
                buf[3] = uint8(9)
                return buf.Length + int32(buf[3])
            }

            func Main() { Console.WriteLine(Use()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("13\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1522_exe_").FullName;
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

            IlVerifier.Verify(dllPath, ignoredErrorCodes: LocallocIlVerifyIgnored);

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
