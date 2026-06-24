// <copyright file="Issue1056ClassConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1056: end-to-end CLR emit + ilverify coverage for a generic
/// constrained by a USER-declared base class (<c>where T : BaseClass</c>).
/// Validates that instance-member dispatch through the base-class constraint
/// emits the verifiable <c>constrained. !!T  callvirt Animal::Speak()</c>
/// sequence, that a GenericParamConstraint metadata row pointing at the class is
/// produced (so ilverify accepts the assembly), and that virtual dispatch
/// resolves the most-derived override at runtime.
/// </summary>
public class Issue1056ClassConstraintEmitTests
{
    [Fact]
    public void EndToEnd_BaseClassConstraint_DispatchesVirtualOverrideAndPrintsWoof()
    {
        var source = """
            package p
            open class Animal { open func Speak() string { return "..." } }
            open class Dog : Animal { override func Speak() string { return "woof" } }
            func Describe[T Animal](x T) string { return x.Speak() }
            func Main() { System.Console.WriteLine(Describe[Dog](Dog())) }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("woof\n", output);
    }

    [Fact]
    public void Library_BaseClassConstraint_PassesIlVerify()
    {
        // ilverify is invoked unconditionally by CompileLibrary; a missing
        // GenericParamConstraint row or a bare (un-constrained) callvirt on the
        // unboxed type parameter would fail verification here.
        var source = """
            package p
            open class Animal { open func Speak() string { return "..." } }
            func Describe[T Animal](x T) string { return x.Speak() }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_SelfReferentialBaseClassConstraints_PassIlVerify()
    {
        // The CRTP `[T Box]` and `[T Box[T]]` shapes over a user-declared class
        // that names itself in its own type-parameter constraint.
        var source = """
            package p
            open class Box[T Box] { }
            open class Box2[T Box2[T]] { }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1056_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_1056_exe_").FullName;
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
