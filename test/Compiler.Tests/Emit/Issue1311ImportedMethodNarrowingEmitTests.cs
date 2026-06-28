// <copyright file="Issue1311ImportedMethodNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1311: end-to-end CLR emit + ilverify coverage proving that calling an
/// imported/BCL method whose parameter is a narrower integer type
/// (<c>System.IO.Stream.WriteByte(byte)</c>) with a bare in-range <c>int</c>
/// literal binds, emits a correctly-typed <c>uint8</c> constant, and produces
/// the right runtime bytes (C# §10.2.11, issues #1281/#1306/#1307). The literal
/// must round-trip through <c>MemoryStream</c> with the exact written values.
/// </summary>
public class Issue1311ImportedMethodNarrowingEmitTests
{
    [Fact]
    public void EndToEnd_ImportedWriteByteLiteralAdapts_ProducesCorrectBytes()
    {
        var source = """
            package p
            import System
            import System.IO
            func Main() {
                var ms = MemoryStream()
                ms.WriteByte(65)
                ms.WriteByte(0)
                ms.WriteByte(255)
                var bytes = ms.ToArray()
                Console.WriteLine(int32(bytes.Length))
                Console.WriteLine(int32(bytes[0]))
                Console.WriteLine(int32(bytes[1]))
                Console.WriteLine(int32(bytes[2]))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("3\n65\n0\n255\n", output);
    }

    [Fact]
    public void Library_ImportedWriteByteLiteralAdapts_PassesIlVerify()
    {
        var source = """
            package p
            import System.IO
            class C {
                func W(file Stream) {
                    file.WriteByte(0)
                }
            }
            """;
        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1311_lib_").FullName;
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

        RunCompiler(args);
        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1311_exe_").FullName;
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

            RunCompiler(args);
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

    private static void RunCompiler(string[] args)
    {
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
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
