// <copyright file="Issue537ForCharInStringEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Regression tests for issue #537: <c>for c in "abc"</c> (string iteration)
/// was rejected with GS0116 "Type 'string' is not indexable." The fix treats
/// <c>string</c> as indexed-iterable over <c>char</c>, using the fast
/// <c>string.get_Chars(int)</c> indexer path — the same lowering C# emits for
/// <c>foreach (char c in str)</c>.
/// </summary>
public class Issue537ForCharInStringEmitTests
{
    [Fact]
    public void ForRange_OverStringLiteral_IteratesCorrectCount()
    {
        var source = """
            package P
            import System

            var n = 0
            for c in "abc" { n = n + 1 }
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void ForRange_OverStringLiteral_YieldsCharsInOrder()
    {
        var source = """
            package P
            import System

            for c in "abc" {
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        // 'a'=97, 'b'=98, 'c'=99
        Assert.Equal("97\n98\n99\n", output);
    }

    [Fact]
    public void ForRange_OverStringVariable_YieldsCharsInOrder()
    {
        var source = """
            package P
            import System

            var s = "xyz"
            for c in s {
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        // 'x'=120, 'y'=121, 'z'=122
        Assert.Equal("120\n121\n122\n", output);
    }

    [Fact]
    public void ForRange_OverEmptyString_ZeroIterations()
    {
        var source = """
            package P
            import System

            var n = 0
            for c in "" { n = n + 1 }
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void ForRange_OverStringWithBmpNonAscii_IteratesCodeUnits()
    {
        // BMP-only non-ASCII: 'é' (U+00E9), '€' (U+20AC), '日' (U+65E5)
        // Each is a single UTF-16 code unit.
        var source = """
            package P
            import System

            for c in "é€日" {
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        // U+00E9=233, U+20AC=8364, U+65E5=26085
        Assert.Equal("233\n8364\n26085\n", output);
    }

    [Fact]
    public void ForRange_OverStringWithSurrogatePair_YieldsTwoCodeUnits()
    {
        // U+1F600 (😀) is a surrogate pair: D83D DE00 in UTF-16.
        // C#'s `foreach (char c in str)` yields the two surrogates separately.
        // We must match that behaviour.
        var source = """
            package P
            import System

            var s = "\uD83D\uDE00"
            for c in s {
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        // High surrogate: 0xD83D = 55357, Low surrogate: 0xDE00 = 56832
        Assert.Equal("55357\n56832\n", output);
    }

    [Fact]
    public void ForRange_OverToCharArray_RegressionGuard()
    {
        // Regression guard: `s.ToCharArray()` was fixed by #545 (char[]),
        // ensure it still works after the string iteration change.
        var source = """
            package P
            import System

            var s = "hi"
            for c in s.ToCharArray() {
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        // 'h'=104, 'i'=105
        Assert.Equal("104\n105\n", output);
    }

    [Fact]
    public void ForRange_OverString_WithKeyVariable_YieldsIndexAndChar()
    {
        var source = """
            package P
            import System

            for i, c in "AB" {
              Console.WriteLine(i)
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        // i=0, 'A'=65, i=1, 'B'=66
        Assert.Equal("0\n65\n1\n66\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue537_").FullName;
        try
        {
            return CompileAndRunImpl(source, tempDir);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunImpl(string source, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
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
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);

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

        using var proc = Process.Start(psi);
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout.Replace("\r\n", "\n");
    }
}
