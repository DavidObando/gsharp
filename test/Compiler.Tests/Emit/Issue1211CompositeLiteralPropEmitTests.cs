// <copyright file="Issue1211CompositeLiteralPropEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1211: end-to-end emit tests proving a composite literal
/// <c>T{Field: value}</c> assigns settable <c>prop</c> auto-property members
/// by calling the property's setter/init accessor (not a <c>stfld</c>). Each
/// test compiles via <c>gsc</c>, runs <c>ilverify</c>, executes the produced
/// assembly, and asserts the property values round-trip — which can only hold
/// if the setter/init accessor actually ran.
/// </summary>
public class Issue1211CompositeLiteralPropEmitTests
{
    [Fact]
    public void ClassCompositeLiteral_GetInitAndGetSetProps_RoundTrip()
    {
        var source = """
            package Probe
            import System

            class C {
                prop TrackId int32 { get; init; }
                prop Name string { get; set }
                var Count int32
            }

            var c = C{TrackId: 7, Name: "abc", Count: 5}
            Console.WriteLine(c.TrackId)
            Console.WriteLine(c.Name)
            Console.WriteLine(c.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\nabc\n5\n", output);
    }

    [Fact]
    public void StructCompositeLiteral_GetInitAndGetSetProps_RoundTrip()
    {
        var source = """
            package Probe
            import System

            struct P {
                prop X int32 { get; init; }
                prop Y int32 { get; set }
                var Z int32
            }

            var p = P{X: 1, Y: 2, Z: 3}
            Console.WriteLine(p.X)
            Console.WriteLine(p.Y)
            Console.WriteLine(p.Z)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n3\n", output);
    }

    [Fact]
    public void ClassCompositeLiteral_InheritedProperty_RoundTrip()
    {
        var source = """
            package Probe
            import System

            open class Base {
                prop Id int32 { get; init; }
            }

            class Derived : Base {
                prop Extra int32 { get; set }
            }

            var d = Derived{Id: 5, Extra: 6}
            Console.WriteLine(d.Id)
            Console.WriteLine(d.Extra)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n6\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1211_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
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
                compileExit = Program.Main(args);
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
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
