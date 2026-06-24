// <copyright file="Issue1066InheritedInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1066: a leaf class satisfies an interface member when the member is
/// implemented (or inherited) anywhere in its base-class chain, even when the
/// interface is reached through interface inheritance (<c>IDerived : IBase</c>)
/// or re-stated on a derived class. These tests give end-to-end CLR emit +
/// ilverify coverage and confirm the inherited implementation dispatches
/// correctly at runtime when invoked through an interface-typed reference.
/// </summary>
public class Issue1066InheritedInterfaceEmitTests
{
    [Fact]
    public void EndToEnd_InterfaceMethodInheritedFromBase_DispatchesThroughInterfaceReference()
    {
        // Leaf (→ Mid → Base) satisfies IBase.M via Base's implementation and is
        // attached to IBase through IDerived : IBase. Calling M() through an
        // IBase-typed parameter must resolve the inherited implementation.
        var source = """
            package p
            interface IBase { func M() int32; }
            interface IDerived : IBase { }
            open class Base : IBase {
                func M() int32 { return 7 }
            }
            open class Mid : Base { init() { } }
            class Leaf : Mid, IDerived { init() { } }
            func Get(x IBase) int32 { return x.M() }
            func Main() { System.Console.WriteLine(Get(Leaf())) }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void Library_InterfacePropertyInheritedFromBase_PassesIlVerify()
    {
        // The canonical issue repro: IBase requires `prop H`, Base implements it,
        // and Leaf reaches IBase through IDerived. ilverify (invoked by
        // CompileLibrary) confirms the emitted assembly is verifiable.
        var source = """
            package p
            interface IBase { prop H int32 { get; } }
            interface IDerived : IBase { }
            open class Base : IBase {
                prop H int32 { get; init; }
                init(h int32) { H = h }
            }
            open class Mid : Base { init(h int32) : base(h) { } }
            class Leaf : Mid, IDerived { init(h int32) : base(h) { } }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_InterfaceOnDerivedSatisfiedByImmediateBase_PassesIlVerify()
    {
        // Requirement coming from a directly-listed interface implemented by a
        // base class.
        var source = """
            package p
            interface IBase { func M() int32; }
            open class Base {
                func M() int32 { return 3 }
            }
            class Leaf : Base, IBase { init() { } }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1066_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_1066_exe_").FullName;
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
