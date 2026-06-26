// <copyright file="Issue1181InterfaceImportedBaseMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1181: a user-defined interface that extends a BCL/imported interface
/// surfaces the imported interface's members on user-interface-typed receivers.
/// These tests give end-to-end CLR emit + ilverify coverage and confirm that a
/// call to an inherited imported member (e.g. <c>IDisposable.Dispose</c>)
/// dispatches correctly at runtime when invoked through the user interface.
/// </summary>
public class Issue1181InterfaceImportedBaseMembersEmitTests
{
    [Fact]
    public void EndToEnd_ImportedBaseInterfaceMethod_DispatchesThroughUserInterface()
    {
        // IBox extends System.IDisposable. Calling b.Dispose() through an
        // IBox-typed parameter must dispatch to Box's implementation.
        var source = """
            package p
            import System
            interface IBox : IDisposable { prop N int32 { get; } }
            class Box : IBox {
                prop N int32 { get; init; }
                func Dispose() { Console.WriteLine("disposed") }
            }
            func Use(b IBox) { b.Dispose() }
            func Main() { Use(Box()) }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("disposed\n", output);
    }

    [Fact]
    public void Library_ImportedBaseInterfaceProperty_ReadThroughUserInterface_PassesIlVerify()
    {
        // IBox extends System.Collections.ICollection; reading b.Count through
        // an IBox-typed reference must emit verifiable IL (a `callvirt
        // get_Count` on the IBox receiver, which carries an InterfaceImpl row
        // to ICollection).
        var source = """
            package p
            import System.Collections
            interface IBox : ICollection { prop N int32 { get; } }
            func Use(b IBox) int32 { return b.Count }
            """;
        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_TransitiveGenericEnumerableThroughUserInterface_PassesIlVerify()
    {
        // IEnumerable<int32> transitively extends the non-generic IEnumerable;
        // GetEnumerator surfaced through the user interface must emit
        // verifiable IL.
        var source = """
            package p
            import System.Collections.Generic
            interface IBox : IEnumerable[int32] { prop N int32 { get; } }
            func Use(b IBox) { let e = b.GetEnumerator() }
            """;
        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1181_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_1181_exe_").FullName;
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
