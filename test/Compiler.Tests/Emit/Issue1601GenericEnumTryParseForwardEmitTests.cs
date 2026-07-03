// <copyright file="Issue1601GenericEnumTryParseForwardEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1601 (follow-up to #1599): a generic BCL method whose type parameter
/// carries a value-type/<c>struct</c> constraint — canonically
/// <c>Enum.TryParse&lt;TEnum&gt;(string, out TEnum)</c> — invoked with a caller
/// type argument that is itself an in-scope generic type parameter constrained
/// to <c>Enum</c>/<c>struct</c> must resolve, bind the inline <c>out var</c> to
/// that type parameter, and emit a verifiable generic method specification.
/// <para>
/// Root cause: the forwarded type parameter <c>TEnum</c> is not a real runtime
/// <see cref="Type"/>, so it erases to a <c>System.Object</c> placeholder in the
/// CLR type-argument vector. The placeholder classifies as a reference type, so
/// the value-type placeholder closure (added by #1599) was skipped and the
/// candidate was dropped — reported as <c>GS0159</c>, which cascaded to
/// <c>GS0125</c> on the inline <c>out var</c> local. The fix classifies a
/// value-type-constrained type parameter as a value-type-erased symbol, exactly
/// like a same-compilation user value type.
/// </para>
/// <para>
/// These are end-to-end emit + execution tests. The generic method is invoked
/// with a real BCL enum (<see cref="DayOfWeek"/>) so it can be exercised at
/// runtime, asserting the parse succeeds and the recovered value is the correct
/// enum member (observed via <c>ToString()</c>). Each test uses UNIQUE
/// function/type names so the name-keyed FunctionTypeSymbol cache does not bleed
/// across the shared in-process test host.
/// </para>
/// </summary>
public class Issue1601GenericEnumTryParseForwardEmitTests
{
    [Fact]
    public void GenericForward_InlineOutVar_ResolvesBindsAndRuns_NoGS0159()
    {
        // The generic function forwards its own Enum/struct-constrained type
        // parameter to Enum.TryParse[TEnum] with an inline `out var`.
        const string source = """
            package Probe
            import System

            func Show1601A[TEnum Enum struct](sample TEnum, arg string) TEnum {
                if !Enum.TryParse[TEnum](arg, out var result) {
                    return sample
                }
                return result
            }

            var hit = Show1601A[DayOfWeek](DayOfWeek.Monday, "Friday")
            Console.WriteLine(hit.ToString())
            var miss = Show1601A[DayOfWeek](DayOfWeek.Monday, "Nope")
            Console.WriteLine(miss.ToString())
            """;

        Assert.Equal("Friday\nMonday\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericForward_IgnoreCaseOverload_ResolvesBindsAndRuns()
    {
        // The three-argument `(string, bool ignoreCase, out TEnum)` overload.
        const string source = """
            package Probe
            import System

            func Show1601B[TEnum Enum struct](sample TEnum, arg string) TEnum {
                if !Enum.TryParse[TEnum](arg, true, out var result) {
                    return sample
                }
                return result
            }

            var hit = Show1601B[DayOfWeek](DayOfWeek.Monday, "friday")
            Console.WriteLine(hit.ToString())
            """;

        Assert.Equal("Friday\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericForward_PreDeclaredReceiver_ResolvesBindsAndRuns_NoGS0159()
    {
        // The pre-declared receiver variant: `out r` where `r` is typed by the
        // value-type-constrained type parameter.
        const string source = """
            package Probe
            import System

            func Show1601C[TEnum Enum struct](sample TEnum, arg string) TEnum {
                var r TEnum = sample
                if !Enum.TryParse[TEnum](arg, out r) {
                    return sample
                }
                return r
            }

            var hit = Show1601C[DayOfWeek](DayOfWeek.Monday, "Friday")
            Console.WriteLine(hit.ToString())
            """;

        Assert.Equal("Friday\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1601_").FullName;
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

            IlVerifier.Verify(outPath, null, Array.Empty<string>());

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
