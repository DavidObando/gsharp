// <copyright file="Issue1255NullableRefUpcastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1255: a nullable→nullable implicit reference conversion <c>T? -> U?</c>
/// (where <c>T</c> derives from or implements <c>U</c>) must bind AND emit. Both
/// sides share the underlying reference's CLR representation, so the upcast is a
/// metadata-only no-op (null stays null, a non-null value reference-upcasts).
/// These tests prove a real value round-trips through a nullable base/interface
/// slot and that null is preserved without an NRE on the upcast itself.
/// </summary>
public class Issue1255NullableRefUpcastEmitTests
{
    [Fact]
    public void NullableClassUpcast_NonNullValue_RoundTrips()
    {
        var source = """
            package Test
            import System

            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base { func Extra() int32 { return 9 } }

            func Read(b Base?) int32 {
                if b != nil {
                    return b.Tag()
                }
                return -1
            }

            let d Derived? = Derived()
            Console.WriteLine(Read(d))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void NullableClassUpcast_NullValue_StaysNull()
    {
        var source = """
            package Test
            import System

            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base { func Extra() int32 { return 9 } }

            func Read(b Base?) int32 {
                if b != nil {
                    return b.Tag()
                }
                return -1
            }

            let d Derived? = nil
            Console.WriteLine(Read(d))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("-1\n", output);
    }

    [Fact]
    public void NullableInterfaceUpcast_NonNullValue_RoundTrips()
    {
        var source = """
            package Test
            import System

            interface IBox { func Size() int32; }
            class AppleListBox : IBox { func Size() int32 { return 42 } }

            func Read(box IBox?) int32 {
                if box != nil {
                    return box.Size()
                }
                return -1
            }

            let a AppleListBox? = AppleListBox()
            Console.WriteLine(Read(a))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void NullableInterfaceUpcast_NullValue_StaysNull()
    {
        var source = """
            package Test
            import System

            interface IBox { func Size() int32; }
            class AppleListBox : IBox { func Size() int32 { return 42 } }

            func Read(box IBox?) int32 {
                if box != nil {
                    return box.Size()
                }
                return -1
            }

            let a AppleListBox? = nil
            Console.WriteLine(Read(a))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("-1\n", output);
    }

    [Fact]
    public void NullableClassUpcast_LetTarget_RoundTrips()
    {
        var source = """
            package Test
            import System

            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base {}

            let d Derived? = Derived()
            let b Base? = d
            Console.WriteLine(b != nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"gsc failed (exit {exitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1255_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/nowarn:GS9100");
            args.Add(srcPath);

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

            if (compileExit != 0)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");

            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
