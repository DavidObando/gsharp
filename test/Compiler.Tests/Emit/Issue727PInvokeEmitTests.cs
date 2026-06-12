// <copyright file="Issue727PInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + execute coverage for ADR-0086 / issue #727: a G#
/// function annotated with <c>@DllImport</c> and a <c>;</c> body lowers
/// to a CLR <c>PinvokeImpl</c> method with an <c>ImplMap</c> row pointing
/// at a deduplicated <c>ModuleRef</c>, and the runtime can invoke the
/// underlying native entry point.
/// </summary>
public class Issue727PInvokeEmitTests
{
    [Fact]
    public void PInvoke_LibcStrLen_RoundTrip_ReturnsExpectedLength()
    {
        if (!IsLibcCallable())
        {
            return; // skip-not-fail per task spec on platforms without libc
        }

        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func strlen_native(text string) nint;

            Console.WriteLine(strlen_native("Hello, world!"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("13\n", output);
    }

    [Fact]
    public void PInvoke_SetLastError_PropagatesToManagedSide()
    {
        if (!IsLibcCallable() || RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // POSIX-only test: open(2) is portable but not universally
            // discoverable through "libc" on Windows. Marshal.GetLastWin32Error
            // is still readable, but the call would resolve differently.
            return;
        }

        // open(2) with O_RDONLY=0 on a missing path sets errno to ENOENT (2).
        // We invoke it via P/Invoke with SetLastError=true and verify that the
        // managed `Marshal.GetLastWin32Error` returns the propagated errno
        // (matching the SetLastError contract on POSIX runtimes — see ADR-0086
        // §3 "SetLastError").
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "open", SetLastError: true)
            func native_open(path string, flags int32) int32;

            var fd = native_open("/no/such/path/should/exist/at/all", 0)
            var err = Marshal.GetLastWin32Error()
            Console.WriteLine(fd)
            Console.WriteLine(err)
            """;

        var output = CompileAndRun(source);
        var lines = output.TrimEnd('\n').Split('\n');
        Assert.Equal(2, lines.Length);
        Assert.Equal("-1", lines[0]);
        Assert.NotEqual("0", lines[1]);
    }

    [Fact]
    public void PInvoke_EmittedMethod_HasPinvokeImpl_And_ImplMap()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func MyStrLen(text string) nint;
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_meta_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var foundPInvoke = false;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                var name = md.GetString(m.Name);
                if (name != "MyStrLen")
                {
                    continue;
                }

                foundPInvoke = true;
                Assert.True((m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl);

                var import = m.GetImport();
                Assert.False(import.Module.IsNil);
                Assert.False(import.Name.IsNil);
                var moduleName = md.GetString(md.GetModuleReference(import.Module).Name);
                Assert.Equal("libc", moduleName);
                Assert.Equal("strlen", md.GetString(import.Name));
                Assert.True((import.Attributes & System.Reflection.MethodImportAttributes.CharSetAnsi) == System.Reflection.MethodImportAttributes.CharSetAnsi);
            }

            Assert.True(foundPInvoke, "expected an emitted P/Invoke method named MyStrLen");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static bool IsLibcCallable()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
        || RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "exe");
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

    private static void CompileOrThrow(string srcPath, string outPath, string target)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }
}
