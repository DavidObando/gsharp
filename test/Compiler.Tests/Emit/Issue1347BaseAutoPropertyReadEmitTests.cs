// <copyright file="Issue1347BaseAutoPropertyReadEmitTests.cs" company="GSharp">
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
/// Issue #1347: end-to-end CLR emit + ilverify coverage for reading and writing
/// a base-class <em>auto-property</em> through <c>base.Prop</c>. An
/// auto-property has no accessor <see cref="GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol"/>
/// — its getter/setter are compiler-synthesized over a backing field — and the
/// original #1104 support mis-bound such a read as a write (GS0127). These tests
/// validate that the read/write now lower to the non-virtual
/// <c>call instance R BaseClass::get_Prop()</c> / <c>... set_Prop(value)</c>
/// shape (NOT <c>callvirt</c>, which would re-enter the derived override and
/// stack-overflow), produce the correct runtime values, and pass ilverify.
/// </summary>
public class Issue1347BaseAutoPropertyReadEmitTests
{
    [Fact]
    public void EndToEnd_BaseDotAutoProperty_Read_RunsSynthesizedGetter()
    {
        var source = """
            package Probe
            import System

            open class Base {
                prop Stored int64 { get; init; }
            }

            open class Deriv : Base {
                func ReadBase() int64 {
                    return base.Stored
                }
            }

            func Main() {
                var d = Deriv{Stored: 17L}
                Console.WriteLine(d.ReadBase())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("17\n", output);
    }

    [Fact]
    public void EndToEnd_BaseDotAutoProperty_ExpressionBodiedReExposure_Reads()
    {
        // The Oahu.Decrypt DashFile shape: a derived expression-bodied member
        // re-exposing the base auto-property (`prop Mirror T -> base.Stored`).
        var source = """
            package Probe
            import System

            open class Base {
                prop Stored int64 { get; init; }
            }

            open class Deriv : Base {
                prop Mirror int64 -> base.Stored
            }

            func Main() {
                var d = Deriv{Stored: 23L}
                Console.WriteLine(d.Mirror)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("23\n", output);
    }

    [Fact]
    public void EndToEnd_BaseDotAutoProperty_Write_RunsSynthesizedSetter()
    {
        var source = """
            package Probe
            import System

            open class Base {
                prop Stored int64 { get; set; }
            }

            open class Deriv : Base {
                func SetBase(v int64) {
                    base.Stored = v
                }
                func ReadBase() int64 {
                    return base.Stored
                }
            }

            func Main() {
                var d = Deriv{Stored: 100L}
                Console.WriteLine(d.ReadBase())
                d.SetBase(42L)
                Console.WriteLine(d.ReadBase())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("100\n42\n", output);
    }

    [Fact]
    public void EndToEnd_BaseDotAutoProperty_ReachesGrandparentGetter()
    {
        var source = """
            package Probe
            import System

            open class A {
                prop Tag int64 { get; init; }
            }

            open class B : A {
            }

            open class C : B {
                func Read() int64 {
                    return base.Tag
                }
            }

            func Main() {
                var c = C{Tag: 5L}
                Console.WriteLine(c.Read())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void Library_BaseDotAutoProperty_PassesIlVerify_AndUsesCallNotCallvirt()
    {
        var source = """
            package Probe

            open class Base {
                prop Stored int64 { get; init; }
            }

            open class Deriv : Base {
                prop Mirror int64 -> base.Stored
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            // Find Deriv::get_Mirror — the expression-bodied getter that
            // contains the base auto-property read.
            MethodDefinitionHandle? mirrorGetter = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "Deriv"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "get_Mirror"))
                    {
                        mirrorGetter = mh;
                    }
                }
            }

            Assert.True(mirrorGetter.HasValue, "expected to find Deriv::get_Mirror");

            var method = reader.GetMethodDefinition(mirrorGetter.Value);
            Assert.True(method.RelativeVirtualAddress != 0, "Deriv::get_Mirror must carry a body");
            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            var ilBytes = body.GetILBytes();
            Assert.NotNull(ilBytes);

            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The base
            // auto-property read MUST be a non-virtual `call` to the
            // synthesized base get_Stored.
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

            Assert.True(sawCall, "Deriv::get_Mirror must contain a `call` opcode (non-virtual base auto-property read)");
            Assert.False(sawCallvirt, "Deriv::get_Mirror must NOT use `callvirt` for base.Stored");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_bap_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_bap_exe_").FullName;
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
