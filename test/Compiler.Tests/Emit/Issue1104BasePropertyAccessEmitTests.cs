// <copyright file="Issue1104BasePropertyAccessEmitTests.cs" company="GSharp">
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
/// Issue #1104: end-to-end CLR emit + ilverify coverage for base-class
/// property access <c>base.Prop</c> (read), <c>base.Prop = value</c> (write),
/// and the explicit-ancestor bracketed form <c>base[BaseClass].Prop</c>.
/// Validates the non-virtual <c>call instance R BaseClass::get_Prop()</c>
/// / <c>... BaseClass::set_Prop(value)</c> shape (NOT <c>callvirt</c>), correct
/// runtime behavior (the selected base accessor runs, no infinite recursion
/// through the derived override, and <c>base[GrandParent]</c> skips the
/// immediate base's override), and that ilverify accepts the produced assembly.
/// </summary>
public class Issue1104BasePropertyAccessEmitTests
{
    [Fact]
    public void EndToEnd_BaseDotProperty_Read_RunsBaseGetter()
    {
        var source = """
            package Probe
            import System

            open class Base {
                open prop RenderSize int64 {
                    get { return 10L }
                }
            }

            open class Deriv() : Base {
                override prop RenderSize int64 {
                    get { return base.RenderSize + 5L }
                }
            }

            func Main() {
                var d = Deriv()
                Console.WriteLine(d.RenderSize)
            }
            """;
        var output = CompileAndRun(source);
        // base.RenderSize == 10 (base getter, no recursion), override adds 5 → 15.
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void EndToEnd_BaseDotProperty_ReachesGrandparentGetter()
    {
        var source = """
            package Probe
            import System

            open class A {
                open prop Tag int64 {
                    get { return 1L }
                }
            }

            open class B() : A {
            }

            open class C() : B {
                override prop Tag int64 {
                    get { return base.Tag + 40L }
                }
            }

            func Main() {
                var c = C()
                Console.WriteLine(c.Tag)
            }
            """;
        var output = CompileAndRun(source);
        // B does not override Tag, so base.Tag resolves to A::get_Tag == 1.
        Assert.Equal("41\n", output);
    }

    [Fact]
    public void EndToEnd_BaseDotProperty_Write_RunsBaseSetter()
    {
        var source = """
            package Probe
            import System

            open class Base {
                var stored int64 = 100L
                open prop Stored int64 {
                    get { return stored }
                    set { stored = value }
                }
            }

            open class Deriv() : Base {
                func SetBase(v int64) {
                    base.Stored = v
                }
                func ReadBase() int64 {
                    return base.Stored
                }
            }

            func Main() {
                var d = Deriv()
                Console.WriteLine(d.ReadBase())
                d.SetBase(42L)
                Console.WriteLine(d.ReadBase())
            }
            """;
        var output = CompileAndRun(source);
        // Initial base.Stored == 100; after base.Stored = 42 it reads back 42.
        Assert.Equal("100\n42\n", output);
    }

    [Fact]
    public void EndToEnd_BracketedBaseProperty_Read_ReachesSpecificAncestor()
    {
        var source = """
            package Probe
            import System

            open class Base {
                open prop RenderSize int64 {
                    get { return 10L }
                }
            }

            open class Mid() : Base {
                override prop RenderSize int64 {
                    get { return 99L }
                }
            }

            open class Deriv() : Mid {
                func Probe() int64 {
                    return base[Base].RenderSize + base.RenderSize
                }
            }

            func Main() {
                var d = Deriv()
                Console.WriteLine(d.Probe())
            }
            """;
        var output = CompileAndRun(source);
        // base[Base].RenderSize == 10 (grandparent, non-virtual) and
        // base.RenderSize == 99 (immediate base Mid) → 109.
        Assert.Equal("109\n", output);
    }

    [Fact]
    public void EndToEnd_BracketedBaseProperty_Write_RunsSpecificAncestorSetter()
    {
        var source = """
            package Probe
            import System

            open class Base {
                var stored int64 = 100L
                open prop Stored int64 {
                    get { return stored }
                    set { stored = value }
                }
            }

            open class Mid() : Base {
            }

            open class Deriv() : Mid {
                func SetBase(v int64) {
                    base[Base].Stored = v
                }
                func ReadBase() int64 {
                    return base[Base].Stored
                }
            }

            func Main() {
                var d = Deriv()
                Console.WriteLine(d.ReadBase())
                d.SetBase(42L)
                Console.WriteLine(d.ReadBase())
            }
            """;
        var output = CompileAndRun(source);
        // Initial base[Base].Stored == 100; after the write it reads back 42.
        Assert.Equal("100\n42\n", output);
    }

    [Fact]
    public void Library_BaseDotProperty_PassesIlVerify_AndUsesCallNotCallvirt()
    {
        var source = """
            package Probe

            open class Base {
                open prop RenderSize int64 {
                    get { return 10L }
                }
            }

            open class Deriv() : Base {
                override prop RenderSize int64 {
                    get { return base.RenderSize }
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            // Find Deriv::get_RenderSize — the override getter that contains the
            // base property read.
            MethodDefinitionHandle? derivGetter = null;
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
                    if (reader.StringComparer.Equals(md.Name, "get_RenderSize"))
                    {
                        derivGetter = mh;
                    }
                }
            }

            Assert.True(derivGetter.HasValue, "expected to find Deriv::get_RenderSize");

            var method = reader.GetMethodDefinition(derivGetter.Value);
            Assert.True(method.RelativeVirtualAddress != 0, "Deriv::get_RenderSize must carry a body");
            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            var ilBytes = body.GetILBytes();
            Assert.NotNull(ilBytes);

            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The override
            // getter body's only call is the base property read, which MUST be a
            // non-virtual `call` (a `callvirt` would re-dispatch into
            // Deriv::get_RenderSize and stack-overflow).
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

            Assert.True(sawCall, "Deriv::get_RenderSize must contain a `call` opcode (non-virtual base property read)");
            Assert.False(sawCallvirt, "Deriv::get_RenderSize must NOT use `callvirt` for base.Prop — it would re-enter the override");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_bpa_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_bpa_exe_").FullName;
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
