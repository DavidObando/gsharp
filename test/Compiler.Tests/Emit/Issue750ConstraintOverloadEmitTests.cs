// <copyright file="Issue750ConstraintOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #750 / ADR-0088 — end-to-end test that the constraint-aware
/// overload resolution lets a single-name <c>Map</c> surface bind
/// correctly across a reference-typed receiver (<c>string?</c>) and a
/// value-typed receiver (<c>int?</c>) using
/// <c>Gsharp.Extensions.Optional</c>. Each test compiles via in-process
/// <c>gsc</c>, IL-verifies the emitted PE (so the chosen overload's
/// metadata round-trips cleanly), and runs the assembly under
/// <c>dotnet exec</c>.
/// </summary>
public class Issue750ConstraintOverloadEmitTests
{
    [Fact]
    public void Map_ResolvesBothClassAndStructOverloads_InSameProgram()
    {
        var source = """
            package Test
            import System
            import Gsharp.Extensions.Optional

            let name string? = "ada"
            let count int32? = 7

            let upper = name.Map(func(s string) string { return s.ToUpper() })
            let doubled = count.Map(func(n int32) int32 { return n * 2 })

            Console.WriteLine(upper ?: "<none>")
            Console.WriteLine(doubled.OrElse(-1).ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ADA\n14\n", output);
    }

    [Fact]
    public void Map_OnNullReferenceReceiver_ReturnsNull()
    {
        var source = """
            package Test
            import System
            import Gsharp.Extensions.Optional

            let absent string? = nil
            let mapped = absent.Map(func(s string) string { return s.ToUpper() })
            Console.WriteLine(mapped ?: "<none>")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("<none>\n", output);
    }

    [Fact]
    public void Map_OnNullValueReceiver_ReturnsNull()
    {
        var source = """
            package Test
            import System
            import Gsharp.Extensions.Optional

            let absent int32? = nil
            let mapped = absent.Map(func(n int32) int32 { return n * 2 })
            Console.WriteLine(mapped.OrElse(-1).ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("-1\n", output);
    }

    [Fact]
    public void OrElse_DisjointConstraints_BindCorrectlyForBothReceiverShapes()
    {
        var source = """
            package Test
            import System
            import Gsharp.Extensions.Optional

            let s string? = nil
            let n int32? = nil

            Console.WriteLine(s.OrElse("default"))
            Console.WriteLine(n.OrElse(99).ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("default\n99\n", output);
    }

    [Fact]
    public void FirstOrNil_SequenceTerminals_BindBothClassAndStructOverloads()
    {
        // FirstOrNil's class overload lives in SequenceExtensions; the struct
        // overload lives in SequenceValueExtensions (separate class because
        // IEnumerable<T> shape is identical for class and struct T). The
        // binder picks the right one per ADR-0088.
        var source = """
            package Test
            import System
            import Gsharp.Extensions.Optional
            import Gsharp.Extensions.Sequences

            let names = Sequences.Of("alpha", "beta")
            let nums = Sequences.Of(11, 22, 33)

            Console.WriteLine(names.FirstOrNil() ?: "<none>")
            Console.WriteLine(nums.FirstOrNil().OrElse(-1).ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("alpha\n11\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue750_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            // Issue #724: link against Gsharp.Extensions.dll and stage it next
            // to the emitted assembly so `dotnet exec` resolves it at runtime.
            var extensionsPath = LocateGsharpExtensionsAssembly();
            Assert.True(
                extensionsPath != null && File.Exists(extensionsPath),
                "Gsharp.Extensions.dll not found in any expected location");
            File.Copy(extensionsPath, Path.Combine(tempDir, "Gsharp.Extensions.dll"), overwrite: true);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/r:" + extensionsPath,
                srcPath,
            };

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
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath, additionalReferences: new[] { extensionsPath });

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
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string LocateGsharpExtensionsAssembly()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(Issue750ConstraintOverloadEmitTests).Assembly.Location));
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                foreach (var cfg in new[] { "Debug", "Release" })
                {
                    var candidate = Path.Combine(dir.FullName, "out", "bin", cfg, "Gsharp.Extensions", "Gsharp.Extensions.dll");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }

                return null;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
