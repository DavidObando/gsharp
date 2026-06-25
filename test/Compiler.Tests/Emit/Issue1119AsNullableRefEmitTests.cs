// <copyright file="Issue1119AsNullableRefEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1119: reference-type <c>as T?</c> (nullable reference target) must bind
/// AND emit. Previously <c>EmitAsExpression</c> only unwrapped the
/// <c>NullableTypeSymbol</c> for value-type targets, so a reference-type
/// <c>as Derived?</c> tried to resolve an element-type token for <c>Derived?</c>
/// and crashed emit with <c>GS9998 'Cannot resolve element type token'</c>.
/// Reference nullability is not a distinct CLR type, so the <c>isinst</c> target
/// must strip the nullable annotation to the underlying reference type.
/// </summary>
public class Issue1119AsNullableRefEmitTests
{
    [Fact]
    public void As_NullableRefType_EmitsCleanly_NoGs9998()
    {
        // The exact repro from the issue, compiled as a library.
        var source = """
            package p
            open class Base {}
            class Derived : Base { func F() int32 { return 1 } }
            class C { func G(b Base) Derived? { return b as Derived? } }
            """;

        var (exitCode, stdout, stderr) = CompileLibraryRaw(source);
        Assert.True(
            exitCode == 0,
            $"gsc failed (exit {exitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.DoesNotContain("GS9998", stdout);
    }

    [Fact]
    public void As_NullableRefType_ReturnsInstance_WhenMatch()
    {
        var source = """
            package Test
            import System

            open class Base {}
            class Derived : Base { func F() int32 { return 7 } }

            let b Base = Derived()
            let d = b as Derived?
            Console.WriteLine(d == nil)
            if d != nil {
                Console.WriteLine(d.F())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n7\n", output);
    }

    [Fact]
    public void As_NullableRefType_ReturnsNull_WhenMismatch()
    {
        var source = """
            package Test
            import System

            open class Base {}
            class Derived : Base { func F() int32 { return 7 } }

            let b Base = Base()
            let d = b as Derived?
            Console.WriteLine(d == nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void As_NonNullableRefType_StillEmits_Regression()
    {
        var source = """
            package Test
            import System

            open class Base {}
            class Derived : Base { func F() int32 { return 7 } }

            let b Base = Derived()
            let d = b as Derived
            Console.WriteLine(d.F())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void As_NullableValueType_StillWorks_WhenMatch()
    {
        var source = """
            package Test
            import System

            let boxed object = 42
            let result = boxed as Int32?
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void As_NullableValueType_StillWorks_WhenMismatch()
    {
        var source = """
            package Test
            import System

            let boxed object = "hello"
            let result = boxed as Int32?
            Console.WriteLine(result == nil)
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

    private static (int ExitCode, string Stdout, string Stderr) CompileLibraryRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1119_lib_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
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

            if (compileExit == 0)
            {
                IlVerifier.Verify(outPath);
            }

            return (compileExit, compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1119_").FullName;
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
