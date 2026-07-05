// <copyright file="Issue2159IfJoinNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2159: end-to-end proof that the <c>if</c>-join narrowing idiom
/// (null-check then reassign in the null branch) both binds and emits
/// verifiable IL that runs to the expected result — the narrowed local is
/// returned as its non-nullable underlying type on every path.
/// </summary>
public class Issue2159IfJoinNarrowingEmitTests
{
    [Fact]
    public void ReassignInNullBranch_NarrowsAtJoin_RunsBothPaths()
    {
        // `norm(nil)` takes the null branch (reassigns to "made"); `norm("kept")`
        // takes the implicit-else path (already non-null). Both reach the
        // narrowed `return r`.
        var source = """
            package Program
            import System

            func mk() string -> "made"

            func norm(s string?) string {
                var r string? = s
                if r == nil { r = mk() }
                return r
            }

            Console.WriteLine(norm(nil))
            Console.WriteLine(norm("kept"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("made\nkept\n", output);
    }

    [Fact]
    public void AssignNonNullInBothBranches_NarrowsAtJoin_Runs()
    {
        var source = """
            package Program
            import System

            func mk() string -> "made"

            func pick(s string?) string {
                var r string?
                if s == nil { r = mk() } else { r = s }
                return r
            }

            Console.WriteLine(pick(nil))
            Console.WriteLine(pick("given"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("made\ngiven\n", output);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2159_").FullName;
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
