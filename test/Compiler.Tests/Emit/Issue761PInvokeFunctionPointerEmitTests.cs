// <copyright file="Issue761PInvokeFunctionPointerEmitTests.cs" company="GSharp">
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
/// End-to-end emit + execute + ilverify coverage for ADR-0095 /
/// issue #761 — P/Invoke function-pointer marshalling. Exercises
/// both supported shapes against real libc entry points so the
/// IL signature, the ImplMap row, the
/// <c>@UnmanagedFunctionPointer</c> CustomAttribute on the synthesized
/// delegate, and the runtime marshalling all line up.
/// </summary>
public class Issue761PInvokeFunctionPointerEmitTests
{
    [Fact]
    public void DllImport_Qsort_With_Delegate_Callback_Sorts_Int64_Buffer()
    {
        if (!IsLibcCallable())
        {
            return; // skip-not-fail on platforms without libc
        }

        // ADR-0095 §3 / Shape A: pass a G#-declared delegate annotated
        // with `@UnmanagedFunctionPointer(CallingConvention.Cdecl)` as
        // libc `qsort`'s comparator. The runtime synthesizes a stable
        // C-ABI thunk for the delegate. After sorting we read the
        // entries back and expect them in ascending order, proving the
        // managed comparator was actually invoked from native code.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @UnmanagedFunctionPointer(CallingConvention.Cdecl)
            type Int64Comparer = delegate func(a nint, b nint) int32

            @DllImport("libc", EntryPoint: "qsort")
            func native_qsort(base nint, nmemb nint, size nint, cmp Int64Comparer) void;

            func compareInt64(a nint, b nint) int32 {
                let av = Marshal.ReadInt64(a)
                let bv = Marshal.ReadInt64(b)
                if av < bv {
                    return -1
                }
                if av > bv {
                    return 1
                }
                return 0
            }

            let buf = Marshal.AllocHGlobal(40)
            Marshal.WriteInt64(buf, 0, 42L)
            Marshal.WriteInt64(buf, 8, 7L)
            Marshal.WriteInt64(buf, 16, 19L)
            Marshal.WriteInt64(buf, 24, 3L)
            Marshal.WriteInt64(buf, 32, 100L)

            let cmp = Int64Comparer(compareInt64)
            native_qsort(buf, IntPtr(5), IntPtr(8), cmp)

            Console.WriteLine(Marshal.ReadInt64(buf, 0))
            Console.WriteLine(Marshal.ReadInt64(buf, 8))
            Console.WriteLine(Marshal.ReadInt64(buf, 16))
            Console.WriteLine(Marshal.ReadInt64(buf, 24))
            Console.WriteLine(Marshal.ReadInt64(buf, 32))

            Marshal.FreeHGlobal(buf)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n7\n19\n42\n100\n", output);
    }

    [Fact]
    public void LibraryImport_Qsort_With_Delegate_Callback_Sorts_Int64_Buffer()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // ADR-0095 §3 / Shape A under @LibraryImport: same end-to-end
        // contract as the @DllImport case, but flows through the
        // outer-stub + inner-PInvoke pair emitted by the LibraryImport
        // path (ADR-0092). Both methods must carry compatible
        // signatures for the delegate argument so the marshaller can
        // synthesize the thunk at the inner boundary.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @UnmanagedFunctionPointer(CallingConvention.Cdecl)
            type Int64Comparer = delegate func(a nint, b nint) int32

            @LibraryImport("libc", EntryPoint: "qsort")
            func native_qsort(base nint, nmemb nint, size nint, cmp Int64Comparer) void;

            func compareInt64(a nint, b nint) int32 {
                let av = Marshal.ReadInt64(a)
                let bv = Marshal.ReadInt64(b)
                if av < bv {
                    return -1
                }
                if av > bv {
                    return 1
                }
                return 0
            }

            let buf = Marshal.AllocHGlobal(24)
            Marshal.WriteInt64(buf, 0, 5L)
            Marshal.WriteInt64(buf, 8, 1L)
            Marshal.WriteInt64(buf, 16, 3L)

            let cmp = Int64Comparer(compareInt64)
            native_qsort(buf, IntPtr(3), IntPtr(8), cmp)

            Console.WriteLine(Marshal.ReadInt64(buf, 0))
            Console.WriteLine(Marshal.ReadInt64(buf, 8))
            Console.WriteLine(Marshal.ReadInt64(buf, 16))

            Marshal.FreeHGlobal(buf)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n3\n5\n", output);
    }

    [Fact]
    public void DllImport_FunctionPointer_ReturnType_Encodes_As_FNPTR()
    {
        // ADR-0095 §3 / Shape B: a raw function-pointer return type
        // (`unmanaged[Cdecl] () -> void`) encodes as an
        // ELEMENT_TYPE_FNPTR (0x1B) signature blob. Verify the inner
        // signature byte sequence so a future regression that erases
        // the FNPTR encoding back to `nint` is caught at metadata
        // time, not just at runtime.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "dlsym")
            func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_761_fnptr_ret_").FullName;
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
                var name = md.GetString(m.Name);
                if (name != "native_dlsym")
                {
                    continue;
                }

                var sig = md.GetBlobBytes(m.Signature);
                Assert.Contains((byte)SignatureTypeCode.FunctionPointer, sig);
                found = true;
            }

            Assert.True(found, "expected an emitted P/Invoke method named native_dlsym");
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
    public void DllImport_FunctionPointer_Parameter_Encodes_As_FNPTR()
    {
        // ADR-0095 §3 / Shape B for a parameter: the metadata blob
        // for a raw function-pointer parameter must contain
        // ELEMENT_TYPE_FNPTR (0x1B), not just the address-sized
        // IntPtr fallback.
        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "qsort")
            func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_761_fnptr_par_").FullName;
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
                var name = md.GetString(m.Name);
                if (name != "native_qsort")
                {
                    continue;
                }

                var sig = md.GetBlobBytes(m.Signature);
                Assert.Contains((byte)SignatureTypeCode.FunctionPointer, sig);
                found = true;
            }

            Assert.True(found, "expected an emitted P/Invoke method named native_qsort");
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
    public void DelegateWith_UnmanagedFunctionPointer_Attribute_Emits_CustomAttribute_Row()
    {
        // ADR-0095 §4: the `@UnmanagedFunctionPointer` annotation on a
        // delegate declaration must flow into the emitted assembly as
        // a regular CustomAttribute row on the delegate TypeDef so
        // the CLR records the calling convention used to synthesize
        // the C-ABI thunk.
        const string source = """
            package P
            import System.Runtime.InteropServices

            @UnmanagedFunctionPointer(CallingConvention.Cdecl)
            type MyCallback = delegate func(a nint) int32
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_761_attr_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var foundAttr = false;
            foreach (var th in md.TypeDefinitions)
            {
                var td = md.GetTypeDefinition(th);
                if (md.GetString(td.Name) != "MyCallback")
                {
                    continue;
                }

                foreach (var ca in td.GetCustomAttributes())
                {
                    var attr = md.GetCustomAttribute(ca);
                    var ctorH = attr.Constructor;
                    string ownerName = null;
                    if (ctorH.Kind == HandleKind.MemberReference)
                    {
                        var mref = md.GetMemberReference((MemberReferenceHandle)ctorH);
                        if (mref.Parent.Kind == HandleKind.TypeReference)
                        {
                            var tref = md.GetTypeReference((TypeReferenceHandle)mref.Parent);
                            ownerName = md.GetString(tref.Name);
                        }
                    }

                    if (ownerName == "UnmanagedFunctionPointerAttribute")
                    {
                        foundAttr = true;
                    }
                }
            }

            Assert.True(foundAttr, "expected [UnmanagedFunctionPointer] CustomAttribute on the delegate TypeDef");
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
        var tempDir = Directory.CreateTempSubdirectory("gs_761_emit_").FullName;
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
