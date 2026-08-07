// <copyright file="Issue3317NilCompareWarningSuppressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3317 / ADR-0159: GS0523 (statically-constant nil comparison) is a
/// warning-severity diagnostic, so the standard gsc suppression/promotion
/// plumbing applies: it surfaces by default without failing the build,
/// <c>/nowarn:GS0523</c> suppresses it, and <c>/warnaserror</c> promotes it
/// to a build-failing error.
/// </summary>
public class Issue3317NilCompareWarningSuppressionTests
{
    private const string DeadNilCheckSource = """
        package P3317Gsc

        func Dead(m map[string, int32]) bool {
            return m == nil
        }
        """;

    [Fact]
    public void Gs0521_SurfacesAsWarning_BuildSucceeds()
    {
        var (exit, output) = CompileLibrary(DeadNilCheckSource, extraArgs: Array.Empty<string>());

        Assert.Equal(0, exit);
        Assert.Contains("GS0523", output);
    }

    [Fact]
    public void Gs0521_NowarnSuppresses()
    {
        var (exit, output) = CompileLibrary(DeadNilCheckSource, extraArgs: new[] { "/nowarn:GS0523" });

        Assert.Equal(0, exit);
        Assert.DoesNotContain("GS0523", output);
    }

    [Fact]
    public void Gs0521_WarnAsErrorFailsBuild()
    {
        var (exit, output) = CompileLibrary(DeadNilCheckSource, extraArgs: new[] { "/warnaserror" });

        Assert.NotEqual(0, exit);
        Assert.Contains("GS0523", output);
    }

    private static (int ExitCode, string Output) CompileLibrary(string source, string[] extraArgs)
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, source);
        var tempDir = Directory.CreateTempSubdirectory("gsc_gs0521_").FullName;
        var outPath = Path.Combine(tempDir, "P3317Gsc.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var args = new string[extraArgs.Length + 3];
            args[0] = "/out:" + outPath;
            args[1] = "/target:library";
            Array.Copy(extraArgs, 0, args, 2, extraArgs.Length);
            args[^1] = sample;
            var exit = Program.Main(args);
            return (exit, outWriter.ToString() + errWriter.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }

            try
            {
                File.Delete(sample);
            }
            catch
            {
            }
        }
    }
}
