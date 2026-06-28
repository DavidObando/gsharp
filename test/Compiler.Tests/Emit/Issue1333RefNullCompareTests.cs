// <copyright file="Issue1333RefNullCompareTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1333: comparing a <em>non-nullable</em> reference (or class/interface)
/// value to <c>nil</c> with <c>==</c> / <c>!=</c> (or matching it against a
/// <c>case nil</c> constant pattern) must be accepted and yield <c>bool</c>,
/// mirroring C#/Kotlin where any reference can be compared to <c>null</c>
/// because a CLR reference can still be null at runtime (default field value,
/// uninitialised auto-property, interop). The comparison keeps working for
/// <c>T?</c> and stays REJECTED for genuine value types (GS0129).
///
/// Each positive test compiles via <c>gsc</c>, IL-verifies the produced PE,
/// then executes it under <c>dotnet exec</c> and asserts on captured stdout.
/// </summary>
public class Issue1333RefNullCompareTests
{
    [Fact]
    public void NonNullClassReference_EqualsAndNotEqualsNil_NonNullValue()
    {
        var source = """
            package P

            import System

            class Box { var V int32 }

            func IsNil(b Box) bool { return b == nil }
            func NotNil(b Box) bool { return b != nil }

            let present = Box{V: 1}
            Console.WriteLine(IsNil(present))
            Console.WriteLine(NotNil(present))
            """;

        // present == nil -> False; present != nil -> True.
        Assert.Equal("False\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NonNullClassReference_NilFromUninitialisedField_ComparesTrue()
    {
        var source = """
            package P

            import System

            class Box { var V int32 }
            class Holder { var Inner Box }

            func IsNil(b Box) bool { return b == nil }
            func NotNil(b Box) bool { return b != nil }

            let h = Holder{}
            Console.WriteLine(IsNil(h.Inner))
            Console.WriteLine(NotNil(h.Inner))
            """;

        // Inner is an uninitialised reference field => null at runtime.
        // null == nil -> True; null != nil -> False.
        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void NonNullInterfaceReference_ComparedToNil()
    {
        var source = """
            package P

            import System

            interface Shape {
                func Area() int32;
            }

            class Sq : Shape {
                var Side int32
                func Area() int32 { return this.Side * this.Side }
            }

            func IsNil(s Shape) bool { return s == nil }
            func NotNil(s Shape) bool { return nil != s }

            let s Shape = Sq{Side: 3}
            Console.WriteLine(IsNil(s))
            Console.WriteLine(NotNil(s))
            """;

        // present interface ref: == nil -> False; nil != s -> True.
        Assert.Equal("False\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NonNullClassReference_CaseNilPattern()
    {
        var source = """
            package P

            import System

            class Box { var V int32 }
            class Holder { var Inner Box }

            func Describe(b Box) string {
                return switch b {
                    case nil: "absent"
                    default: "present"
                }
            }

            let present = Box{V: 1}
            let h = Holder{}
            Console.WriteLine(Describe(present))
            Console.WriteLine(Describe(h.Inner))
            """;

        Assert.Equal("present\nabsent\n", CompileAndRun(source));
    }

    [Fact]
    public void ClassConstrainedTypeParameter_ComparedToNil()
    {
        var source = """
            package P

            import System

            class Box { var V int32 }

            func IsNil[T class](x T) bool { return x == nil }
            func NotNil[T class](x T) bool { return x != nil }

            let present = Box{V: 1}
            Console.WriteLine(IsNil[Box](present))
            Console.WriteLine(NotNil[Box](present))
            """;

        Assert.Equal("False\nTrue\n", CompileAndRun(source));
    }

    // ── Negative: a non-nullable VALUE type compared to nil still GS0129 ──

    [Fact]
    public void NonNullValueType_ComparedToNil_ProducesGs0129()
    {
        var source = """
            package P

            func Bad(x int32) bool { return x == nil }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0129") && d.Contains("'=='") && d.Contains("nil"));
    }

    [Fact]
    public void StructConstrainedTypeParameter_ComparedToNil_ProducesGs0129()
    {
        var source = """
            package P

            func Bad[T struct](x T) bool { return x == nil }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0129") && d.Contains("'=='") && d.Contains("nil"));
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1333_").FullName;
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
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

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

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1333_neg_").FullName;
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
                "/nowarn:GS9100",
            };
            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

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

            Assert.True(compileExit != 0, $"expected gsc to report errors but it succeeded\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
