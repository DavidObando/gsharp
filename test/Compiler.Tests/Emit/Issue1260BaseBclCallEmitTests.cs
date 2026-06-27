// <copyright file="Issue1260BaseBclCallEmitTests.cs" company="GSharp">
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
/// Issue #1260: end-to-end CLR emit + ilverify coverage for <c>base.Member(...)</c>
/// and <c>base.Prop</c> accesses into an <b>imported / BCL</b> base class (e.g.
/// <see cref="object.ToString"/>, <c>System.IO.Stream.Dispose(bool)</c> via
/// <see cref="System.IO.MemoryStream"/>). Before the fix the binder rejected
/// these with GS0383 because the GSharp class had no user <c>StructSymbol</c>
/// base. Validates the non-virtual <c>call</c> shape (NOT <c>callvirt</c>, which
/// would re-enter the derived override and recurse), correct runtime behavior,
/// multi-level chains, and that ilverify accepts the produced assembly.
/// </summary>
public class Issue1260BaseBclCallEmitTests
{
    [Fact]
    public void EndToEnd_BaseObjectToString_RunsBaseImplementation()
    {
        var source = """
            package Probe
            import System

            class Greeter {
                open func ToString() string { return base.ToString() + "!" }
            }

            func Main() {
                var g = Greeter()
                Console.WriteLine(g.ToString())
            }
            """;
        var output = CompileAndRun(source);

        // base.ToString() delegates to object.ToString() (the type's full name),
        // then the override appends "!". The key assertion is that no infinite
        // recursion occurs and the suffix is present.
        Assert.Equal("Probe.Greeter!\n", output);
    }

    [Fact]
    public void EndToEnd_BaseStreamDispose_RunsWithoutError()
    {
        var source = """
            package Probe
            import System
            import System.IO

            class MyMem : MemoryStream {
                open func Dispose(disposing bool) {
                    Console.WriteLine("disposing=" + disposing.ToString())
                    base.Dispose(disposing)
                }
            }

            func Main() {
                var m = MyMem()
                m.Dispose(true)
                Console.WriteLine("done")
            }
            """;
        var output = CompileAndRun(source);

        // The virtual-with-body base Dispose(bool) runs and returns; no recursion.
        Assert.Equal("disposing=True\ndone\n", output);
    }

    [Fact]
    public void EndToEnd_MultiLevel_UserBaseThenBcl_ResolvesToBcl()
    {
        var source = """
            package Probe
            import System
            import System.IO

            open class Wrapper : MemoryStream { }

            class MyMem : Wrapper {
                open func Dispose(disposing bool) {
                    base.Dispose(disposing)
                    Console.WriteLine("after-base")
                }
            }

            func Main() {
                var m = MyMem()
                m.Dispose(true)
            }
            """;

        // The nearest user base (Wrapper) does not declare Dispose(bool); the
        // base call resolves up to MemoryStream.Dispose(bool).
        var output = CompileAndRun(source);
        Assert.Equal("after-base\n", output);
    }

    [Fact]
    public void EndToEnd_BaseBclProperty_ReadAndWrite()
    {
        var source = """
            package Probe
            import System
            import System.IO

            class MyMem : MemoryStream {
                func RoundTrip() int64 {
                    base.Position = 0
                    return base.Position
                }
            }

            func Main() {
                var m = MyMem()
                Console.WriteLine(m.RoundTrip().ToString())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void Library_BaseBclCall_PassesIlVerify_AndUsesCallNotCallvirt()
    {
        var source = """
            package Probe
            import System.IO

            class MyMem : MemoryStream {
                open func Dispose(disposing bool) {
                    base.Dispose(disposing)
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            MethodDefinitionHandle? disposeHandle = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "MyMem"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Dispose"))
                    {
                        disposeHandle = mh;
                    }
                }
            }

            Assert.True(disposeHandle.HasValue, "expected to find MyMem::Dispose");

            var method = reader.GetMethodDefinition(disposeHandle.Value);
            Assert.True(method.RelativeVirtualAddress != 0, "MyMem::Dispose must carry a body");
            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            var ilBytes = body.GetILBytes();
            Assert.NotNull(ilBytes);

            // ECMA-335 opcodes: `call` = 0x28; `callvirt` = 0x6F. The base call
            // into the BCL base MUST be a non-virtual `call` (a `callvirt` would
            // re-dispatch into MyMem::Dispose and stack-overflow).
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

            Assert.True(sawCall, "MyMem::Dispose must contain a `call` opcode (non-virtual base BCL call)");
            Assert.False(sawCallvirt, "MyMem::Dispose must NOT use `callvirt` for base.Dispose() — it would re-enter the override");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_bcl_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_bcl_exe_").FullName;
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
            TryCleanup(tempDir);
        }
    }

    private static void TryCleanup(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
            else if (File.Exists(path))
            {
                var dir = Path.GetDirectoryName(path);
                if (dir != null && Directory.Exists(dir))
                {
                    Directory.Delete(dir, recursive: true);
                }
            }
        }
        catch
        {
            // Best-effort cleanup.
        }
    }
}
