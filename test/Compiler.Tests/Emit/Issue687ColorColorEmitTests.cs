// <copyright file="Issue687ColorColorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #687: end-to-end emit + runtime validation for the C# "color color"
/// rule and the qualified-namespace-path escape hatch. A class with a field
/// whose name shadows an imported type (<c>Path string</c> alongside
/// <c>System.IO.Path</c>) must compile, the static call <c>Path.Combine</c>
/// inside the method body must bind against <c>System.IO.Path</c>, and the
/// fully-qualified <c>System.IO.Path.Combine(...)</c> spelling must continue
/// to work as an escape hatch.
/// </summary>
public class Issue687ColorColorEmitTests
{
    [Fact]
    public void ColorColor_FieldShadowsImportedType_StaticCallEmitsAndRuns()
    {
        var source = """
            package P
            import System
            import System.IO

            type Entry class {
                Path string = ""

                func Build(suffix string) string {
                    return Path.Combine(this.Path, suffix)
                }
            }

            var e = Entry() { Path = "root" }
            Console.WriteLine(e.Build("leaf.txt"))
            """;

        var output = CompileAndRun(source);
        var expected = System.IO.Path.Combine("root", "leaf.txt") + "\n";
        Assert.Equal(expected, output);
    }

    [Fact]
    public void QualifiedNamespacePath_StaticCallEmitsAndRuns()
    {
        var source = """
            package P
            import System

            Console.WriteLine(System.IO.Path.Combine("a", "b"))
            """;

        var output = CompileAndRun(source);
        var expected = System.IO.Path.Combine("a", "b") + "\n";
        Assert.Equal(expected, output);
    }

    [Fact]
    public void ColorColor_InstanceMemberAccess_FallsBackToField()
    {
        // Field type is `string` and `Path.Length` is an instance member of the
        // string value, not a static of System.IO.Path. The fall-back must keep
        // the instance interpretation, returning the length of the field value
        // ("/tmp" → 4) at runtime.
        var source = """
            package P
            import System
            import System.IO

            type Probe class {
                Path string = ""

                func Len() int32 {
                    return Path.Length
                }
            }

            var p = Probe() { Path = "/tmp" }
            Console.WriteLine(p.Len())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue687_").FullName;
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

            using var proc = Process.Start(psi);
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
