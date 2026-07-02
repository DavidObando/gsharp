// <copyright file="Issue1599EnumTryParseOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1599: a generic BCL method whose type parameter carries a value-type
/// (<c>where T : struct</c>) constraint — canonically
/// <c>Enum.TryParse&lt;TEnum&gt;(string, out TEnum)</c> and its
/// <c>(string, bool, out TEnum)</c> overload — invoked with a SAME-COMPILATION
/// user enum both crashed the compiler with an internal <c>GS9999</c>
/// (<see cref="System.Collections.Generic.KeyNotFoundException"/>) on the inline
/// <c>out var</c> form and failed to resolve at all (<c>GS0159</c>) with a
/// pre-declared receiver.
/// <para>
/// Root cause: overload resolution closes the method over a value-type
/// placeholder (because the user enum has no reference-context CLR type), and
/// that placeholder leaked into the inline <c>out var</c> local's type. The fix
/// recovers the out-parameter pointee from the explicit type-argument symbols
/// (generalizing to any value-type-constrained generic + <c>out var</c>) and
/// makes a pre-declared by-ref argument over a same-compilation user value type
/// match the value-type-constrained generic parameter.
/// </para>
/// <para>
/// These are end-to-end emit + execution tests: they compile via <c>gsc</c> and
/// run the produced assembly, asserting the parse succeeds and the recovered
/// value is the correct enum member (observed via <c>ToString()</c>, which for a
/// real emitted enum yields the member name). Each test uses a UNIQUE enum name
/// so the name-keyed FunctionTypeSymbol cache does not bleed across the shared
/// in-process test host.
/// </para>
/// </summary>
public class Issue1599EnumTryParseOutVarEmitTests
{
    [Fact]
    public void InlineOutVar_UserEnum_ResolvesBindsAndRuns_NoGS9999()
    {
        // Exact shape of the minimal repro from the issue.
        const string source = """
            package Probe
            import System

            enum Palette1599A { Crimson, Emerald }

            var ok = Enum.TryParse[Palette1599A]("Emerald", out var result)
            Console.WriteLine(ok)
            Console.WriteLine(result.ToString())
            """;

        Assert.Equal("True\nEmerald\n", CompileAndRun(source));
    }

    [Fact]
    public void InlineOutVar_UserEnum_ParseFailure_ReturnsFalse()
    {
        const string source = """
            package Probe
            import System

            enum Palette1599B { Crimson, Emerald }

            var ok = Enum.TryParse[Palette1599B]("Nope", out var result)
            Console.WriteLine(ok)
            """;

        Assert.Equal("False\n", CompileAndRun(source));
    }

    [Fact]
    public void InlineOutVar_IgnoreCaseOverload_Resolves()
    {
        // The three-argument `(string, bool ignoreCase, out TEnum)` overload.
        const string source = """
            package Probe
            import System

            enum Palette1599C { Crimson, Emerald }

            var ok = Enum.TryParse[Palette1599C]("emerald", true, out var result)
            Console.WriteLine(ok)
            Console.WriteLine(result.ToString())
            """;

        Assert.Equal("True\nEmerald\n", CompileAndRun(source));
    }

    [Fact]
    public void PreDeclaredReceiver_UserEnum_Resolves_NoGS0159()
    {
        // The pre-declared-receiver variant that previously failed with GS0159.
        const string source = """
            package Probe
            import System

            enum Palette1599D { Crimson, Emerald }

            var r Palette1599D = Palette1599D.Crimson
            var ok = Enum.TryParse[Palette1599D]("Emerald", out r)
            Console.WriteLine(ok)
            Console.WriteLine(r.ToString())
            """;

        Assert.Equal("True\nEmerald\n", CompileAndRun(source));
    }

    [Fact]
    public void BclEnum_TryParse_StillWorks_Regression()
    {
        // Control: a value-type constraint over a real BCL enum keeps working
        // (it is closed over the real CLR type, not the placeholder).
        const string source = """
            package Probe
            import System

            var ok = Enum.TryParse[DayOfWeek]("Friday", out var d)
            Console.WriteLine(ok)
            Console.WriteLine(d.ToString())
            """;

        Assert.Equal("True\nFriday\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1599_").FullName;
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
