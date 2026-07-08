// <copyright file="Issue2229TupleBoxingConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2229: a tuple element conversion that boxes a nullable VALUE type to
/// a nullable reference target (e.g. <c>int32? -> object?</c>) must not just
/// bind — it must emit a real box so the runtime value observed through the
/// target-typed tuple is the boxed value (or an actual null reference when the
/// source has no value), exactly like the equivalent scalar
/// <c>int32? -> object?</c> argument conversion. This proves the fix (a new
/// arm in <c>Conversion.Classify</c>'s lifted-nullable-target branch) flows
/// through <c>ConversionClassifier.BindTupleConversion</c>'s existing
/// per-element lowering (issue #1256) to produce verifiable IL.
/// </summary>
public class Issue2229TupleBoxingConversionEmitTests
{
    [Fact]
    public void NullableInt32Element_BoxedToObject_RoundTripsValue()
    {
        var source = """
            package Test
            import System

            func Take(t (string, object?)) string {
                return t.Item1 + ":" + t.Item2.ToString()
            }

            func F(n int32?) string { return Take(("count", n)) }

            Console.WriteLine(F(42))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("count:42\n", output);
    }

    [Fact]
    public void NullableBoolElement_BoxedToObject_RoundTripsValue()
    {
        var source = """
            package Test
            import System

            func Take(t (string, object?)) string {
                return t.Item1 + ":" + t.Item2.ToString()
            }

            func F(b bool?) string { return Take(("ok", b)) }

            Console.WriteLine(F(true))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok:True\n", output);
    }

    [Fact]
    public void NullValuedNullableElement_BoxedToObject_ProducesNullReference()
    {
        var source = """
            package Test
            import System

            func Take(t (string, object?)) string {
                if t.Item2 == nil {
                    return t.Item1 + ":nil"
                }
                return t.Item1 + ":" + t.Item2.ToString()
            }

            func F(n int32?) string { return Take(("count", n)) }

            Console.WriteLine(F(nil))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("count:nil\n", output);
    }

    [Fact]
    public void ParamsTupleArray_MixedNullableValueElements_RoundTripsValues()
    {
        // The exact repro shape from issue #2229: a variadic `(string, object?)`
        // slice packed from tuple literals whose second element is a different
        // nullable value type per argument.
        var source = """
            package Test
            import System

            func Args(pairs ...(string, object?)) string {
                var result string = ""
                for p in pairs {
                    result = result + p.Item1 + "=" + p.Item2.ToString() + ";"
                }
                return result
            }

            func F(n int32?, b bool?) string {
                return Args(("count", n), ("ok", b))
            }

            Console.WriteLine(F(7, false))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("count=7;ok=False;\n", output);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2229_").FullName;
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
