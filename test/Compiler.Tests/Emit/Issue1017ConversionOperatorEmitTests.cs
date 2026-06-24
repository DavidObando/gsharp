// <copyright file="Issue1017ConversionOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.PortableExecutable;
using System.Reflection.Metadata;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1017: user-defined implicit/explicit conversion operators declared in
/// G# with the <c>func operator implicit/explicit (x T) U</c> syntax. These emit
/// CLR <c>op_Implicit</c>/<c>op_Explicit</c> special-name methods and participate
/// in conversion/overload resolution like C#.
/// Each test compiles via in-process <c>gsc</c>, IL-verifies the PE, then runs
/// under <c>dotnet exec</c> and asserts captured stdout.
/// </summary>
public class Issue1017ConversionOperatorEmitTests
{
    [Fact]
    public void Implicit_Conversion_Applied_At_Assignment()
    {
        var source = """
            package Test
            import System

            struct Celsius {
                var degrees float64
            }

            func operator implicit (c Celsius) float64 {
                return c.degrees
            }

            let c = Celsius{degrees: 100.0}
            let d float64 = c
            Console.WriteLine(d)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("100\n", output);
    }

    [Fact]
    public void Implicit_Conversion_Applied_At_Argument()
    {
        var source = """
            package Test
            import System

            struct AppleData {
                var bytes []uint8
            }

            func operator implicit (d AppleData) []uint8 {
                return d.bytes
            }

            func sumBytes(data []uint8) int32 {
                var total int32 = 0
                for var i = 0; i < data.Length; i = i + 1 {
                    total = total + int32(data[i])
                }
                return total
            }

            let apple = AppleData{bytes: []uint8{uint8(1), uint8(2), uint8(3), uint8(4)}}
            Console.WriteLine(sumBytes(apple))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n", output);
    }

    [Fact]
    public void Explicit_Conversion_Applied_At_Cast()
    {
        var source = """
            package Test
            import System

            struct AppleData {
                var bytes []uint8
            }

            func operator explicit (b []uint8) AppleData {
                return AppleData{bytes: b}
            }

            let raw = []uint8{uint8(7), uint8(8)}
            let apple = AppleData(raw)
            Console.WriteLine(apple.bytes.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void Both_Implicit_And_Explicit_RoundTrip()
    {
        var source = """
            package Test
            import System

            struct Fahrenheit {
                var degrees float64
            }

            func operator implicit (f Fahrenheit) float64 {
                return f.degrees
            }

            func operator explicit (d float64) Fahrenheit {
                return Fahrenheit{degrees: d}
            }

            let f = Fahrenheit(212.0)
            let raw float64 = f
            Console.WriteLine(raw)
            let back = Fahrenheit(raw)
            Console.WriteLine(back.degrees)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("212\n212\n", output);
    }

    [Fact]
    public void Emits_SpecialName_Static_OpImplicit_And_OpExplicit()
    {
        var source = """
            package Test
            import System

            struct Celsius {
                var degrees float64
            }

            func operator implicit (c Celsius) float64 {
                return c.degrees
            }

            func operator explicit (d float64) Celsius {
                return Celsius{degrees: d}
            }

            let c = Celsius{degrees: 1.0}
            Console.WriteLine(c.degrees)
            """;

        var dllPath = CompileToDll(source);
        try
        {
            using var fs = File.OpenRead(dllPath);
            using var pe = new PEReader(fs);
            var md = pe.GetMetadataReader();

            MethodDefinition? opImplicit = null;
            MethodDefinition? opExplicit = null;
            foreach (var handle in md.MethodDefinitions)
            {
                var method = md.GetMethodDefinition(handle);
                var name = md.GetString(method.Name);
                if (name == "op_Implicit")
                {
                    opImplicit = method;
                }
                else if (name == "op_Explicit")
                {
                    opExplicit = method;
                }
            }

            Assert.True(opImplicit.HasValue, "op_Implicit not emitted");
            Assert.True(opExplicit.HasValue, "op_Explicit not emitted");

            foreach (var m in new[] { opImplicit!.Value, opExplicit!.Value })
            {
                Assert.True(m.Attributes.HasFlag(MethodAttributes.Static), "conversion op must be static");
                Assert.True(m.Attributes.HasFlag(MethodAttributes.SpecialName), "conversion op must be specialname");
                Assert.True(m.Attributes.HasFlag(MethodAttributes.HideBySig), "conversion op must be hidebysig");
                Assert.True(m.Attributes.HasFlag(MethodAttributes.Public), "conversion op must be public");
            }
        }
        finally
        {
            try { Directory.Delete(Path.GetDirectoryName(dllPath)!, recursive: true); } catch { }
        }
    }

    private static string CompileToDll(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1017_md_").FullName;
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

        var prevOut = Console.Out;
        var prevErr = Console.Error;
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
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
            $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"gsc/exec failed (exit {exitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1017_").FullName;
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
