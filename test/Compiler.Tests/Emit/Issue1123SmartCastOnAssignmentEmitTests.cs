// <copyright file="Issue1123SmartCastOnAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1123: Kotlin-style smart cast that narrows a nullable <c>var</c>
/// local to its non-nullable underlying type after it is assigned a
/// statically non-nullable value. These tests prove the narrowed read both
/// binds (member dispatch resolves) and emits/runs correctly — the call
/// dispatches to the expected member and the program produces the expected
/// output.
/// </summary>
public class Issue1123SmartCastOnAssignmentEmitTests
{
    [Fact]
    public void Assignment_NarrowsNullableRefLocal_DispatchesCall()
    {
        // The minimal repro from the issue, run end-to-end: `x` is `E?`,
        // assigned a non-nullable `E`, then `x.M()` must dispatch.
        var source = """
            package Test
            import System

            class E { func M() int32 { return 42 } }

            func F(fresh E) int32 {
                var x E? = nil
                x = fresh
                return x.M()
            }

            Console.WriteLine(F(E()))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Assignment_NarrowingReachesNestedBlock()
    {
        var source = """
            package Test
            import System

            class E { func M() int32 { return 7 } }

            func F(fresh E) int32 {
                var x E? = nil
                x = fresh
                if true {
                    return x.M()
                }
                return 0
            }

            Console.WriteLine(F(E()))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void Assignment_NarrowsToMostDerivedAssignedValue_DispatchesVirtual()
    {
        // `x` is declared `Base?`; after `x = Derived()` the value is provably
        // a non-null Base. Virtual dispatch must reach the Derived override.
        var source = """
            package Test
            import System

            open class Base { open func M() int32 { return 1 } }
            class Derived : Base { override func M() int32 { return 99 } }

            func F(d Derived) int32 {
                var x Base? = nil
                x = d
                return x.M()
            }

            Console.WriteLine(F(Derived()))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void Assignment_NullableValueType_NotNarrowed_ScopedToReferenceTypes()
    {
        // Issue #1123 is scoped to reference types: nullable value types
        // (`int32?`) are intentionally NOT narrowed on assignment because the
        // narrowed-read emit path does not unwrap `Nullable<T>`. Reading the
        // value type directly still requires an explicit unwrap (e.g. a nil
        // guard), so a bare arithmetic read here must fail to compile.
        var source = """
            package Test
            import System

            func F(n int32) int32 {
                var x int32? = nil
                x = n
                return x + 1
            }

            Console.WriteLine(F(41))
            """;

        var (exitCode, _, _) = CompileAndRunRaw(source);
        Assert.NotEqual(0, exitCode);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1123_").FullName;
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
