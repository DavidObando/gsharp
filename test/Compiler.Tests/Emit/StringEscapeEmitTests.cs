// <copyright file="StringEscapeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #531: end-to-end emit-and-execute coverage for backslash escape
/// sequences in double-quoted string literals.
/// </summary>
public class StringEscapeEmitTests
{
    [Fact]
    public void Newline_Escape_ProducesLength3()
    {
        var source = """
            package P
            import System

            let s = "a\nb"
            Console.WriteLine(s.Length)
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void Tab_Escape_ProducesTab()
    {
        var source = """
            package P
            import System

            let s = "a\tb"
            Console.WriteLine(s)
            """;

        Assert.Equal("a\tb\n", CompileAndRun(source));
    }

    [Fact]
    public void Unicode_Escape_ProducesCharacter()
    {
        var source = """
            package P
            import System

            let s = "\u00e9"
            Console.WriteLine(s)
            """;

        Assert.Equal("\u00e9\n", CompileAndRun(source));
    }

    [Fact]
    public void Backslash_Escape_ProducesLiteral()
    {
        var source = """
            package P
            import System

            let s = "a\\b"
            Console.WriteLine(s.Length)
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void Quote_Escape_ProducesQuote()
    {
        var source = """
            package P
            import System

            let s = "say \"hi\""
            Console.WriteLine(s)
            """;

        Assert.Equal("say \"hi\"\n", CompileAndRun(source));
    }

    [Fact]
    public void Hex_Escape_ProducesCharacter()
    {
        var source = """
            package P
            import System

            let s = "\x41"
            Console.WriteLine(s)
            """;

        Assert.Equal("A\n", CompileAndRun(source));
    }

    [Fact]
    public void RawString_DoesNotProcessEscapes()
    {
        var source = """
            package P
            import System

            let s = `a\nb`
            Console.WriteLine(s.Length)
            """;

        Assert.Equal("4\n", CompileAndRun(source));
    }

    [Fact]
    public void InterpolatedString_EscapesInLiteralSegment()
    {
        var source = """
            package P
            import System

            let x = 42
            let s = "val:\t${x}\n"
            Console.WriteLine(s.Length)
            """;

        // "val:\t" = 5 chars + "42" = 2 chars + "\n" = 1 char = 8
        Assert.Equal("8\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_str_esc_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
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
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
