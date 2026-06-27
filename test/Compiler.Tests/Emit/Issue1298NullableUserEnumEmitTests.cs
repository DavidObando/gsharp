// <copyright file="Issue1298NullableUserEnumEmitTests.cs" company="GSharp">
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
/// Issue #1298: nullable user-defined enums (<c>E?</c>) support lifted equality
/// and inequality with C#/<c>Nullable&lt;T&gt;</c> semantics, both in the binder
/// (no GS0129 "operator not defined") and the emitter (no GS9998 ICE encoding
/// <c>Nullable&lt;E&gt;</c>). Two <c>nil</c>s are equal, a <c>nil</c> and a value
/// are unequal, and two values compare by the enum's underlying integral value.
///
/// Each test compiles via <c>gsc</c>, IL-verifies the produced PE, then executes
/// it under <c>dotnet exec</c> and asserts on captured stdout.
/// </summary>
public class Issue1298NullableUserEnumEmitTests
{
    [Fact]
    public void NullableEnumEqualsEnum_PresentMatch_IsTrue()
    {
        var source = """
            package P

            import System

            enum E { A, B }

            func Eq(x E?) bool { return x == E.A }

            let a E? = E.A
            let b E? = E.B
            let n E? = nil
            Console.WriteLine(Eq(a))
            Console.WriteLine(Eq(b))
            Console.WriteLine(Eq(n))
            """;

        // present A == A -> True; present B == A -> False; nil == A -> False.
        Assert.Equal("True\nFalse\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableEnumNotEqualsEnum_LiftsOverNil()
    {
        var source = """
            package P

            import System

            enum E { A, B }

            func Ne(x E?) bool { return x != E.A }

            let a E? = E.A
            let b E? = E.B
            let n E? = nil
            Console.WriteLine(Ne(a))
            Console.WriteLine(Ne(b))
            Console.WriteLine(Ne(n))
            """;

        // A != A -> False; B != A -> True; nil != A -> True (nil unequal to value).
        Assert.Equal("False\nTrue\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableEnumEqualsNil_DistinguishesPresentFromAbsent()
    {
        var source = """
            package P

            import System

            enum E { A, B }

            func IsNil(x E?) bool { return x == nil }
            func NotNil(x E?) bool { return x != nil }

            let a E? = E.A
            let n E? = nil
            Console.WriteLine(IsNil(a))
            Console.WriteLine(IsNil(n))
            Console.WriteLine(NotNil(a))
            Console.WriteLine(NotNil(n))
            """;

        // a==nil -> False; n==nil -> True; a!=nil -> True; n!=nil -> False.
        Assert.Equal("False\nTrue\nTrue\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void NilEqualsNullableEnum_SymmetricOperand()
    {
        var source = """
            package P

            import System

            enum E { A, B }

            func IsNil(x E?) bool { return nil == x }

            let a E? = E.A
            let n E? = nil
            Console.WriteLine(IsNil(a))
            Console.WriteLine(IsNil(n))
            """;

        Assert.Equal("False\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableEnumEqualsNullableEnum_LiftedSemantics()
    {
        var source = """
            package P

            import System

            enum E { A, B }

            func Eq(x E?, y E?) bool { return x == y }
            func Ne(x E?, y E?) bool { return x != y }

            let a E? = E.A
            let b E? = E.B
            let n E? = nil
            Console.WriteLine(Eq(n, n))
            Console.WriteLine(Eq(a, n))
            Console.WriteLine(Eq(a, a))
            Console.WriteLine(Eq(a, b))
            Console.WriteLine(Ne(a, b))
            Console.WriteLine(Ne(n, n))
            """;

        // nil==nil -> True; a==nil -> False; a==a -> True; a==b -> False;
        // a!=b -> True; nil!=nil -> False.
        Assert.Equal("True\nFalse\nTrue\nFalse\nTrue\nFalse\n", CompileAndRun(source));
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1298_").FullName;
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
