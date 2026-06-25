// <copyright file="Issue1113TransitiveConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1113: a generic interface constraint (<c>[T IFace]</c>) must be
/// satisfied when the type argument implements the interface ANYWHERE in its
/// hierarchy — directly, through a base class, or via a transitively-inherited
/// base interface (mirrors C#'s <c>where T : IFace</c>). Before the fix only
/// interfaces directly declared on the type argument were considered, so a class
/// inheriting the interface through its base class was wrongly rejected with
/// GS0152. These tests compile, ilverify, and RUN the repro to prove dispatch
/// through the inherited constraint works at runtime.
/// </summary>
public class Issue1113TransitiveConstraintEmitTests
{
    [Fact]
    public void EndToEnd_InterfaceInheritedFromBaseClass_SatisfiesConstraintAndDispatches()
    {
        // FreeBox inherits IBox via its base class Box (does NOT re-declare it).
        var source = """
            package p
            interface IBox { func F() int32; }
            open class Box : IBox { func F() int32 { return 1 } }
            class FreeBox : Box { }
            class Helper {
                func Use[T IBox](x T) int32 { return x.F() }
                func Call() int32 { return Use(FreeBox()) }
            }
            func Main() { System.Console.WriteLine(Helper().Call()) }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceInheritedFromGrandparent_SatisfiesConstraintAndDispatches()
    {
        // Two-level base chain: the grandparent declares the interface; the
        // intermediate and leaf classes only inherit it.
        var source = """
            package p
            interface IBox { func F() int32; }
            open class Box : IBox { func F() int32 { return 7 } }
            open class MidBox : Box { }
            class LeafBox : MidBox { }
            class Helper {
                func Use[T IBox](x T) int32 { return x.F() }
                func Call() int32 { return Use(LeafBox()) }
            }
            func Main() { System.Console.WriteLine(Helper().Call()) }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_DirectImplementer_StillSatisfiesConstraint()
    {
        // Positive regression: the direct-implementer case must keep working.
        var source = """
            package p
            interface IBox { func F() int32; }
            open class Box : IBox { func F() int32 { return 3 } }
            class Helper {
                func Use[T IBox](x T) int32 { return x.F() }
                func Call() int32 { return Use(Box()) }
            }
            func Main() { System.Console.WriteLine(Helper().Call()) }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void Library_InheritedInterfaceConstraint_PassesIlVerify()
    {
        // ilverify is invoked unconditionally by CompileLibrary; a missing
        // GenericParamConstraint row or a bare callvirt on the unboxed type
        // parameter would fail verification here.
        var source = """
            package p
            interface IBox { func F() int32; }
            open class Box : IBox { func F() int32 { return 1 } }
            class FreeBox : Box { }
            class Helper {
                func Use[T IBox](x T) int32 { return x.F() }
                func Call() int32 { return Use(FreeBox()) }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1113_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        RunCompiler(args);
        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1113_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            RunCompiler(args);
            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void RunCompiler(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
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
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
