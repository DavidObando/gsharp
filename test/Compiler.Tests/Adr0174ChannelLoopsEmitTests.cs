// <copyright file="Adr0174ChannelLoopsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0174 D3 through the real driver: <c>gsc</c> emits a program that uses
/// <c>for v in ch</c>, <c>while let v = &lt;-ch</c> and the two-value receive;
/// the assembly passes ILVerify (the lowering reuses the tuple, declaration,
/// goto and label nodes, so any stack or scope mistake in the new shapes would
/// surface here); and the program's own output pins the semantics — drain to
/// close, a delivered <c>nil</c> element, and the <c>ok</c> flag.
/// </summary>
public class Adr0174ChannelLoopsEmitTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        yield return new object[]
        {
            "for-in-drains-a-goroutine-producer",
            """
            package P
            import System

            func produce(w out chan[int32], n int32) {
                for i in 1 ... n {
                    w <- i
                }
                w.Close()
            }

            let ch = chan[int32](2)
            go produce(ch, 6)
            var sum = 0
            for v in ch {
                sum = sum + v
            }
            Console.WriteLine(sum)
            """,
            new[] { "15" },
        };

        yield return new object[]
        {
            "while-let-delivers-nil-elements",
            """
            package P
            import System

            let ch = chan[string?](3)
            ch <- "a"
            ch <- nil
            ch <- "b"
            ch.Close()
            while let s = <-ch {
                Console.WriteLine(s ?? "<nil>")
            }
            Console.WriteLine("closed")
            """,
            new[] { "a", "<nil>", "b", "closed" },
        };

        yield return new object[]
        {
            "two-value-receive-forms",
            """
            package P
            import System

            let ch = chan[int32](2)
            ch <- 7
            ch <- 8
            let (first, ok1) = <-ch
            var second = 0
            var ok2 = false
            second, ok2 = <-ch
            ch.Close()
            let (zero, ok3) = <-ch
            Console.WriteLine("{0} {1} {2} {3} {4} {5}", first, ok1, second, ok2, zero, ok3)
            """,
            new[] { "7 True 8 True 0 False" },
        };

        yield return new object[]
        {
            "while-let-short-circuits-across-clauses",
            """
            package P
            import System

            let x = chan[int32](1)
            let y = chan[int32](1)
            x.Close()
            y <- 5
            while let a = <-x, let b = <-y {
                Console.WriteLine("unexpected")
            }
            Console.WriteLine(y.Length())
            """,
            new[] { "1" },
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void ChannelLoops_CompileVerifyAndRun(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_0174_loops_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, name + ".dll");

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
                $"gsc failed for '{name}':\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
