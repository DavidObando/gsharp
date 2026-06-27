// <copyright file="Issue1236NullableNumericWideningEmitTests.cs" company="GSharp">
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
/// Issue #1236: a lifted (nullable) binary operator honours the same implicit
/// lossless integer-widening lattice and constant-integer-literal adaptation as
/// its non-nullable counterpart. The binder converts both operands to a common
/// <c>Nullable&lt;underlying&gt;</c> so the lifted operator is homogeneous; the new
/// machinery is a lifted <c>Nullable&lt;T1&gt; → Nullable&lt;T2&gt;</c> numeric-widening
/// conversion (null stays null, present values convert through the underlying
/// numeric type). Null semantics match the existing same-underlying lifted
/// operators.
///
/// Each test compiles via <c>gsc</c>, IL-verifies the produced PE, then executes
/// it under <c>dotnet exec</c> and asserts on captured stdout.
/// </summary>
public class Issue1236NullableNumericWideningEmitTests
{
    [Fact]
    public void LiftedLiteralEquality_Present_IsTrue()
    {
        var source = """
            package P

            import System

            func Eq(b uint8?) bool { return b == 11 }

            let v uint8 = 11
            let b uint8? = v
            Console.WriteLine(Eq(b))
            Console.WriteLine(Eq(nil))
            """;

        // present 11 == 11 -> True; nil == 11 -> False (lifted equality).
        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedDirectionalWideningEquality_Present_IsTrue()
    {
        var source = """
            package P

            import System

            func Eq(a uint8?, b int32?) bool { return a == b }

            let av uint8 = 3
            let a uint8? = av
            let bv int32 = 3
            let b int32? = bv
            Console.WriteLine(Eq(a, b))
            Console.WriteLine(Eq(a, nil))
            """;

        // uint8? 3 == int32? 3 -> True; uint8? 3 == nil -> False.
        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedArithmeticWidening_Present_AddsThroughUnderlying()
    {
        var source = """
            package P

            import System

            func Add(a int64?, b int32?) int64? { return a + b }

            let av int64 = 5
            let a int64? = av
            let bv int32 = 11
            let b int32? = bv
            Console.WriteLine(Add(a, b).ToString())
            Console.WriteLine(Add(a, nil) == nil)
            """;

        // 5 + 11 -> 16; 5 + nil -> nil (null-propagation).
        Assert.Equal("16\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedLiteralArithmetic_AdaptsLiteralToUnderlying()
    {
        var source = """
            package P

            import System

            func Add(b int64?) int64? { return b + 11 }

            let v int64 = 5
            let b int64? = v
            Console.WriteLine(Add(b).ToString())
            Console.WriteLine(Add(nil) == nil)
            """;

        Assert.Equal("16\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedOrderingWidening_Present_ComparesThroughUnderlying()
    {
        var source = """
            package P

            import System

            func Lt(a uint8?, b int32?) bool { return a < b }

            let av uint8 = 3
            let a uint8? = av
            let bv int32 = 10
            let b int32? = bv
            Console.WriteLine(Lt(a, b))
            Console.WriteLine(Lt(a, nil))
            """;

        // 3 < 10 -> True; 3 < nil -> False (lifted ordering with a null operand).
        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1236_").FullName;
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
