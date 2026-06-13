// <copyright file="Issue760PInvokeRefOutInEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + execute + ilverify coverage for ADR-0094 / issue #760 —
/// P/Invoke <c>ref</c>/<c>out</c>/<c>in</c> parameter marshalling. Exercises
/// both <c>@DllImport</c> and <c>@LibraryImport</c> against real libc
/// entry points so the IL signature, ImplMap row, and runtime marshalling
/// all line up.
/// </summary>
public class Issue760PInvokeRefOutInEmitTests
{
    [Fact]
    public void DllImport_RefInt64_LibcTime_WritesBack_Through_RefSlot()
    {
        if (!IsLibcCallable())
        {
            return; // skip-not-fail on platforms without libc
        }

        // libc `time(time_t *t)` returns the current Unix time and writes
        // the same value through the pointer. After the call:
        //   rc > 0   (time is past 1970)
        //   rc == t  (the byref slot received the same value)
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "time")
            func native_time(ref t int64) int64;

            var t = 0L
            var rc = native_time(ref t)
            Console.WriteLine(rc > 0L)
            Console.WriteLine(rc == t)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\n", output);
    }

    [Fact]
    public void DllImport_RefStruct_ClockGetTime_WritesBack_Through_RefStructSlot()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // libc `clock_gettime(CLOCK_REALTIME=0, struct timespec *)` writes
        // the current epoch time into the byref slot. `struct timespec`
        // on every supported 64-bit POSIX platform is two 8-byte words
        // (`time_t tv_sec`, `long tv_nsec`), which the G# `TimeSpec`
        // struct mirrors. CLOCK_REALTIME == 0 is portable across glibc
        // and Apple libc (CLOCK_MONOTONIC's numeric value differs).
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct TimeSpec {
                var tv_sec int64
                var tv_nsec int64
            }

            @DllImport("libc", EntryPoint: "clock_gettime")
            func clock_gettime_native(clk_id int32, ref tp TimeSpec) int32;

            var ts = TimeSpec{tv_sec: 0L, tv_nsec: 0L}
            var rc = clock_gettime_native(0, ref ts)
            Console.WriteLine(rc)
            Console.WriteLine(ts.tv_sec > 0L)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\nTrue\n", output);
    }

    [Fact]
    public void DllImport_OutPrimitive_LibcTime_AcceptsOutModifier()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // `out t` requires definite assignment by the callee. libc `time`
        // writes its return value through the pointer, satisfying the
        // out contract for blittable primitives.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "time")
            func native_time(out t int64) int64;

            var t = 0L
            var rc = native_time(out t)
            Console.WriteLine(rc == t)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void DllImport_InPrimitive_IsAccepted_And_Emits()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // `in` is a read-only byref. The callee gets a pointer it must not
        // mutate. libc `time` ignores the input and overwrites the pointee
        // with the current time, but the managed slot is still passed by
        // address. We compile + IL-verify + run to confirm the signature
        // shape is accepted end to end.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "time")
            func native_time(in t int64) int64;

            var t = 0L
            var rc = native_time(in t)
            Console.WriteLine(rc > 0L)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void LibraryImport_RefInt64_LibcTime_WritesBack_Through_RefSlot()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // The @LibraryImport outer stub forwards each byref parameter by
        // loading the managed pointer slot (ldarg.s with byref type) and
        // calling the inner blittable P/Invoke. No marshalling stub is
        // required for blittable primitives — the IL just hands the same
        // address to the inner call.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "time")
            func native_time(ref t int64) int64;

            var t = 0L
            var rc = native_time(ref t)
            Console.WriteLine(rc > 0L)
            Console.WriteLine(rc == t)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\n", output);
    }

    [Fact]
    public void DllImport_RefParameter_EmitsByRefSignature_In_ImplMap()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // Read the emitted MethodDef signature and confirm the parameter
        // is encoded with the ELEMENT_TYPE_BYREF sentinel before the
        // pointee. Without this byte, the runtime would reinterpret the
        // managed pointer as a 64-bit value and corrupt the call frame.
        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "time")
            func native_time(ref t int64) int64;
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_ref_meta_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var found = false;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                if (md.GetString(m.Name) != "native_time")
                {
                    continue;
                }

                found = true;
                Assert.True(
                    (m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl,
                    "native_time should carry PinvokeImpl");
                var sigBytes = md.GetBlobBytes(m.Signature);
                // The signature blob layout we care about is:
                // [calling-conv][param-count][return-type][ELEMENT_TYPE_BYREF=0x10][pointee=I8].
                // The ByRef sentinel appears immediately before the pointee type.
                Assert.Contains((byte)SignatureTypeCode.ByReference, sigBytes);
            }

            Assert.True(found, "expected an emitted P/Invoke method named native_time");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    public void LibraryImport_RefParameter_BothInnerAndOuter_Encode_ByRef()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // @LibraryImport emits two MethodDefs — an outer managed stub and a
        // hidden inner P/Invoke. For ref-kind parameters both must carry
        // the ELEMENT_TYPE_BYREF sentinel so the address forwarded from
        // outer.ldarg to inner.call is interpreted correctly at the
        // unmanaged boundary.
        const string source = """
            package P
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "time")
            func native_time(ref t int64) int64;
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_libimp_ref_meta_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            int outerWithByRef = 0;
            int innerWithByRef = 0;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                var name = md.GetString(m.Name);
                var sigBytes = md.GetBlobBytes(m.Signature);
                if (name == "native_time" && System.Linq.Enumerable.Contains(sigBytes, (byte)SignatureTypeCode.ByReference))
                {
                    outerWithByRef++;
                }
                else if (name.Contains("native_time") && name.Contains("PInvoke")
                         && System.Linq.Enumerable.Contains(sigBytes, (byte)SignatureTypeCode.ByReference))
                {
                    innerWithByRef++;
                }
            }

            Assert.True(outerWithByRef >= 1, "outer LibraryImport stub should encode ref parameter as byref");
            Assert.True(innerWithByRef >= 1, "inner LibraryImport PInvoke should encode ref parameter as byref");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static bool IsLibcCallable()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
        || RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_refout_emit_").FullName;
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
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
