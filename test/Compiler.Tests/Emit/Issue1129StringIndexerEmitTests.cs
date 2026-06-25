// <copyright file="Issue1129StringIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1129: indexing a <c>string</c> with <c>s[i]</c> was rejected with
/// GS0116. .NET's <c>string</c> exposes <c>char this[int]</c>
/// (<c>get_Chars</c>), so <c>s[i]</c> yields the <c>char</c> at that position.
/// The binder now maps <c>string[int]</c> to a <c>BoundIndexExpression</c> with
/// a <c>char</c> result; emit already lowered that node to
/// <c>System.String.get_Chars(int)</c> (issue #537). These tests compile and
/// run real programs end-to-end.
/// </summary>
public class Issue1129StringIndexerEmitTests
{
    [Fact]
    public void StringIndex_ByConstant_YieldsCharCode()
    {
        // Acceptance criteria #2: end-to-end `s[1]` of "ABCD" is 'B' = 66.
        var source = """
            package P
            import System

            var s = "ABCD"
            let c = s[1]
            Console.WriteLine(int32(c))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("66\n", output);
    }

    [Fact]
    public void StringIndex_FirstChar_YieldsCharCode()
    {
        var source = """
            package P
            import System

            var s = "ABCD"
            Console.WriteLine(int32(s[0]))
            """;

        var output = CompileAndRun(source);

        // 'A' = 65
        Assert.Equal("65\n", output);
    }

    [Fact]
    public void StringIndex_ByVariable_YieldsCharCode()
    {
        // Acceptance criteria #3: indexing with a non-constant int variable.
        var source = """
            package P
            import System

            var s = "ABCD"
            var i = 2
            Console.WriteLine(int32(s[i]))
            """;

        var output = CompileAndRun(source);

        // 'C' = 67
        Assert.Equal("67\n", output);
    }

    [Fact]
    public void StringIndex_PrintedAsChar()
    {
        var source = """
            package P
            import System

            var s = "ABCD"
            Console.WriteLine(s[3])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("D\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1129_").FullName;
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
