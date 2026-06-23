// <copyright file="Issue986BaseClassCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #986: end-to-end CLR emit + ilverify coverage for the base-class
/// call forms <c>base.M(...)</c> and <c>base[BaseClass].M(...)</c>. Validates
/// the non-virtual <c>call instance ... BaseClass::M(...)</c> shape (NOT
/// <c>callvirt</c>), correct runtime behavior (the base implementation runs,
/// no infinite recursion), and that ilverify accepts the produced assembly.
/// </summary>
public class Issue986BaseClassCallEmitTests
{
    [Fact]
    public void EndToEnd_BaseDotCall_RunsBaseImplementation()
    {
        var source = """
            package Probe
            import System

            open class Shape {
                open func Describe() string { return "shape" }
            }

            class Circle() : Shape {
                override func Describe() string { return base.Describe() + " circle" }
            }

            func Main() {
                var c = Circle()
                Console.WriteLine(c.Describe())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("shape circle\n", output);
    }

    [Fact]
    public void EndToEnd_BaseBracketCall_RunsBaseImplementation()
    {
        var source = """
            package Probe
            import System

            open class Shape {
                open func Describe() string { return "shape" }
            }

            class Circle() : Shape {
                override func Describe() string { return base[Shape].Describe() + " circle" }
            }

            func Main() {
                var c = Circle()
                Console.WriteLine(c.Describe())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("shape circle\n", output);
    }

    [Fact]
    public void EndToEnd_BaseCall_WithParametersAndReturn()
    {
        var source = """
            package Probe
            import System

            open class Adder {
                open func Add(a int32, b int32) int32 { return a + b }
            }

            class LoggingAdder() : Adder {
                override func Add(a int32, b int32) int32 { return base.Add(a, b) + 100 }
            }

            func Main() {
                var x = LoggingAdder()
                Console.WriteLine(x.Add(2, 3))
            }
            """;
        var output = CompileAndRun(source);
        // base.Add(2,3) == 5, override adds 100 → 105.
        Assert.Equal("105\n", output);
    }

    [Fact]
    public void EndToEnd_BaseCall_ReachesGrandparentImplementation()
    {
        var source = """
            package Probe
            import System

            open class A {
                open func Name() string { return "A" }
            }

            open class B() : A {
            }

            class C() : B {
                override func Name() string { return base.Name() + "C" }
            }

            func Main() {
                var c = C()
                Console.WriteLine(c.Name())
            }
            """;
        var output = CompileAndRun(source);
        // B does not override Name, so base.Name() resolves to A::Name.
        Assert.Equal("AC\n", output);
    }

    [Fact]
    public void Library_BaseDotCall_PassesIlVerify_AndUsesCallNotCallvirt()
    {
        var source = """
            package Probe

            open class Shape {
                open func Tag() string { return "shape" }
            }

            class Circle() : Shape {
                override func Tag() string {
                    return base.Tag()
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            // Find Circle::Tag — the override that contains the base `call`.
            MethodDefinitionHandle? circleTag = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "Circle"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Tag"))
                    {
                        circleTag = mh;
                    }
                }
            }

            Assert.True(circleTag.HasValue, "expected to find Circle::Tag");

            var method = reader.GetMethodDefinition(circleTag.Value);
            Assert.True(method.RelativeVirtualAddress != 0, "Circle::Tag must carry a body");
            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            var ilBytes = body.GetILBytes();
            Assert.NotNull(ilBytes);

            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The override
            // body's only call is the base call, which MUST be a non-virtual
            // `call` (a `callvirt` would re-dispatch into Circle::Tag and
            // stack-overflow).
            bool sawCall = false;
            bool sawCallvirt = false;
            for (int i = 0; i < ilBytes.Length; i++)
            {
                if (ilBytes[i] == 0x28)
                {
                    sawCall = true;
                }
                else if (ilBytes[i] == 0x6F)
                {
                    sawCallvirt = true;
                }
            }

            Assert.True(sawCall, "Circle::Tag must contain a `call` opcode (non-virtual base class call)");
            Assert.False(sawCallvirt, "Circle::Tag must NOT use `callvirt` for base.M() — it would re-enter the override");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_bcc_lib_").FullName;
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

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_bcc_exe_").FullName;
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
