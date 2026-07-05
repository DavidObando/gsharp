// <copyright file="Issue2051TupleNullableWrapEmitTests.cs" company="GSharp">
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
/// Issue #2051: the implicit `T -> Nullable&lt;T&gt;` lift (issue #504) must
/// also fire when `T` is a ValueTuple-shaped value type. The
/// <c>EmitConversion</c> lift arm keys off <c>from == toValueNullableLift.UnderlyingType</c>,
/// which holds for tuple types (they are interned via
/// <c>TupleTypeSymbol.Get</c>), but the arm was never reached for a bare
/// tuple-literal initializer/argument because
/// <see cref="System.Reflection.Emit"/>... (see production code comments) —
/// the fix ensures a raw <c>ValueTuple`2</c> is never left on the stack where
/// a <c>Nullable`1&lt;ValueTuple`2&gt;</c> is expected.
/// </summary>
public class Issue2051TupleNullableWrapEmitTests
{
    [Fact]
    public void LocalVariableInitializer_TupleLiteralIntoNullableTuple_WrapsAndVerifies()
    {
        var source = """
            package TupleNullableLocalPkg

            import System

            var p (int32, int32)? = (0, 0)
            let v = p!!
            Console.WriteLine(v.Item1)
            Console.WriteLine(v.Item2)
            """;

        Assert.Equal("0\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void ArgumentPassing_TupleLiteralIntoNullableTupleParameter_WrapsAndVerifies()
    {
        var source = """
            package TupleNullableArgPkg

            import System

            func Test(v (int32, int32)?) int32 {
                let t = v!!
                return t.Item1 + t.Item2
            }

            Console.WriteLine(Test((3, 4)))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void ReturnPosition_TupleLiteralIntoNullableTupleReturnType_WrapsAndVerifies()
    {
        var source = """
            package TupleNullableReturnPkg

            import System

            func Make() (int32, int32)? {
                return (5, 6)
            }

            let r = Make()!!
            Console.WriteLine(r.Item1)
            Console.WriteLine(r.Item2)
            """;

        Assert.Equal("5\n6\n", CompileAndRun(source));
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2051_").FullName;
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
