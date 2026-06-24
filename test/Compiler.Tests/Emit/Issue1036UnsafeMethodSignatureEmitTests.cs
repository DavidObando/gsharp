// <copyright file="Issue1036UnsafeMethodSignatureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1036 / ADR-0122 §1: end-to-end emit + execution tests for an
/// <c>unsafe func</c> method declared inside an otherwise-<em>safe</em> type.
/// The method's SIGNATURE (parameter + return types) binds in an unsafe
/// context, so it may take/return unmanaged raw pointers (<c>*T</c> →
/// CLR <c>ELEMENT_TYPE_PTR</c>) without marking the whole type
/// <c>unsafe class</c> / <c>unsafe struct</c>. Each test compiles via
/// <c>gsc</c> and executes the produced assembly under <c>dotnet exec</c> to
/// assert runtime behavior.
/// <para>
/// Genuinely-unsafe pointer code is unverifiable by design, so the inherent
/// pointer verification codes are passed to <c>ignoredErrorCodes</c> while
/// still gating on any NEW unrelated verification regressions.
/// </para>
/// </summary>
public class Issue1036UnsafeMethodSignatureEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    [Fact]
    public void UnsafeMethod_InSafeClass_PointerParamAndReturn_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            class Safe {
                unsafe func bump(p *int32) *int32 {
                    *p = *p + 1
                    return p
                }
            }

            unsafe func run() {
                var arr = []int32{41}
                var s = Safe()
                var q = s.bump(&arr[0])
                Console.WriteLine(*q)
                Console.WriteLine(arr[0])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n42\n", output);
    }

    [Fact]
    public void UnsafeMethod_InSafeStruct_PointerParamAndReturn_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            struct Safe {
                unsafe func bump(p *int32) *int32 {
                    *p = *p + 10
                    return p
                }
            }

            unsafe func run() {
                var arr = []int32{5}
                var s = Safe{}
                var q = s.bump(&arr[0])
                Console.WriteLine(*q)
                Console.WriteLine(arr[0])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n15\n", output);
    }

    [Fact]
    public void UnsafeStaticMethod_InSafeClass_PointerParam_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            class Safe {
                shared {
                    unsafe func add(p *int32, n int32) {
                        *p = *p + n
                    }
                }
            }

            unsafe func run() {
                var arr = []int32{100}
                Safe.add(&arr[0], 23)
                Console.WriteLine(arr[0])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("123\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1036_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
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
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            // Unsafe pointer code is unverifiable by design; tolerate the
            // inherent-unsafety error codes while still gating on other
            // verification regressions.
            IlVerifier.Verify(outPath, null, UnsafeIlVerifyIgnored);

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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
