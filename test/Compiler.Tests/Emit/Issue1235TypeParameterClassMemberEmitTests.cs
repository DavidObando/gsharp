// <copyright file="Issue1235TypeParameterClassMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1235: end-to-end CLR emit + ilverify coverage for instance FIELD and
/// PROPERTY access on a value whose static type is a type parameter constrained
/// to a (user) class or interface. Methods already dispatched through the
/// constraint (issue #1056); these tests validate that fields, (inherited)
/// properties, and interface properties are surfaced too, that the emitted
/// <c>box !!T; ldfld</c> / <c>box !!T; callvirt get_X</c> sequences pass
/// ilverify, and that the reads return the right values at runtime.
/// </summary>
public class Issue1235TypeParameterClassMemberEmitTests
{
    [Fact]
    public void EndToEnd_ClassConstraint_ReadsFieldPropertyMethodAndInherited()
    {
        var source = """
            package p
            open class GrandBase { prop Inherited int32 { get; set; } }
            open class Base : GrandBase {
              prop P int32 { get; set; }
              var F2 int32
              func Hello() int32 { return 42 }
            }
            open class C[T Base] {
              func ReadProp(t T) int32 { return t.P }
              func ReadField(t T) int32 { return t.F2 }
              func CallMethod(t T) int32 { return t.Hello() }
              func ReadInherited(t T) int32 { return t.Inherited }
            }
            func Main() {
              var b = Base()
              b.P = 7
              b.F2 = 13
              b.Inherited = 100
              var c = C[Base]()
              var sum = c.ReadProp(b) + c.ReadField(b) + c.CallMethod(b) + c.ReadInherited(b)
              System.Console.WriteLine(sum)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("162\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceConstraint_ReadsProperty()
    {
        var source = """
            package p
            interface IHasName { prop Name int32 { get; } }
            open class Named : IHasName { prop Name int32 { get; set; } }
            open class D[T IHasName] {
              func ReadIfaceProp(t T) int32 { return t.Name }
            }
            func Main() {
              var n = Named()
              n.Name = 55
              var d = D[Named]()
              System.Console.WriteLine(d.ReadIfaceProp(n))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("55\n", output);
    }

    [Fact]
    public void Library_ClassConstraintFieldAndPropertyReads_PassIlVerify()
    {
        // ilverify is invoked unconditionally by CompileLibrary; a bare ldfld /
        // callvirt on the unboxed `!!T` value (missing the `box !!T`) would fail
        // verification here with StackUnexpected.
        var source = """
            package p
            open class Base {
              prop P int32 { get; set; }
              var F2 int32
            }
            open class C[T Base] {
              func A(t T) int32 { return t.P }
              func B(t T) int32 { return t.F2 }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1235_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_1235_exe_").FullName;
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
