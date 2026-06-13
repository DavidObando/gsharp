// <copyright file="Issue757BaseInterfaceCallEmitTests.cs" company="GSharp">
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
/// ADR-0091 / issue #757: end-to-end CLR emit + ilverify coverage for
/// <c>base[IFoo].M()</c>. Validates the non-virtual <c>call instance ...
/// IFoo::M(...)</c> shape (NOT <c>callvirt</c>), the diamond
/// disambiguation runtime behavior, and that ilverify accepts the
/// produced assembly.
/// </summary>
public class Issue757BaseInterfaceCallEmitTests
{
    [Fact]
    public void EndToEnd_DiamondDelegation_DelegatesToBothDefaults()
    {
        var source = """
            package Probe
            import System

            interface IA {
                func Tag() string { return "A" }
            }

            interface IB {
                func Tag() string { return "B" }
            }

            class C : IA, IB {
                func Tag() string {
                    return base[IA].Tag() + base[IB].Tag()
                }
            }

            func Main() {
                var c = C{}
                Console.WriteLine(c.Tag())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("AB\n", output);
    }

    [Fact]
    public void EndToEnd_NonVirtualCall_DoesNotRecurseThroughOverride()
    {
        // ADR-0091: `base[IGreeter].Hello()` MUST emit `call`, not
        // `callvirt`. If `callvirt` were used the call would re-dispatch
        // through the v-table back into `Loud.Hello` and stack-overflow.
        var source = """
            package Probe
            import System

            interface IGreeter {
                func Hello() string { return "default" }
            }

            class Loud : IGreeter {
                func Hello() string {
                    return base[IGreeter].Hello()
                }
            }

            func Main() {
                var l = Loud{}
                Console.WriteLine(l.Hello())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("default\n", output);
    }

    [Fact]
    public void EndToEnd_DiamondDelegation_ThroughInterfaceTypedReceiver()
    {
        // Diamond + virtual dispatch through interface-typed receiver:
        // the class's override is reached via the v-table, then the
        // override reaches the IA/IB defaults via the non-virtual
        // `call` from ADR-0091.
        var source = """
            package Probe
            import System

            interface IA {
                func V() int32 { return 1 }
            }

            interface IB {
                func V() int32 { return 2 }
            }

            class C : IA, IB {
                func V() int32 {
                    return base[IA].V() + base[IB].V() * 10
                }
            }

            func Main() {
                var c = C{}
                var ia IA = c
                var ib IB = c
                Console.WriteLine(c.V())
                Console.WriteLine(ia.V())
                Console.WriteLine(ib.V())
            }
            """;
        var output = CompileAndRun(source);
        // 1 + 2 * 10 == 21 — all three call-sites converge on C.V via
        // virtual dispatch.
        Assert.Equal("21\n21\n21\n", output);
    }

    [Fact]
    public void Library_DiamondDisambiguation_PassesIlVerify_AndUsesCallNotCallvirt()
    {
        // Compile a library version so we can also inspect metadata /
        // method bodies. ilverify is invoked unconditionally by
        // CompileLibrary.
        var source = """
            package Probe
            import System

            interface IA {
                func Tag() string { return "A" }
            }

            interface IB {
                func Tag() string { return "B" }
            }

            class C : IA, IB {
                func Tag() string {
                    return base[IA].Tag() + base[IB].Tag()
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            // Find C::Tag — the override that contains the `call`s.
            MethodDefinitionHandle? cTag = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "C"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Tag"))
                    {
                        cTag = mh;
                    }
                }
            }

            Assert.True(cTag.HasValue, "expected to find C::Tag");

            var method = reader.GetMethodDefinition(cTag.Value);
            Assert.True(method.RelativeVirtualAddress != 0, "C::Tag must carry a body");
            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            var ilBytes = body.GetILBytes();
            Assert.NotNull(ilBytes);

            // ECMA-335 opcodes: `call` = 0x28 (single byte); `callvirt`
            // = 0x6F. The override body must contain `call` to a method
            // reference for the IA/IB default — and must NOT contain a
            // callvirt opcode in the relevant section (the only calls in
            // the body are the two base-interface ones plus string
            // concat; string concat uses `call`, not `callvirt`).
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

            Assert.True(sawCall, "C::Tag must contain a `call` opcode (non-virtual base interface call)");
            Assert.False(sawCallvirt, "C::Tag must NOT use `callvirt` for base[IFoo].M() — it would re-enter the override");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_bic_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_bic_exe_").FullName;
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
