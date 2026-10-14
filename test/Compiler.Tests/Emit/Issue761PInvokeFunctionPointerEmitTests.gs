// <copyright file="Issue761PInvokeFunctionPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// End-to-end emit + execute + ilverify coverage for ADR-0095 /
/// issue #761 — P/Invoke function-pointer marshalling. Exercises
/// both supported shapes against real libc entry points so the
/// IL signature, the ImplMap row, the
/// `@UnmanagedFunctionPointer` CustomAttribute on the synthesized
/// delegate, and the runtime marshalling all line up.
open class Issue761PInvokeFunctionPointerEmitTests {
    @Fact
    func DllImport_Qsort_With_Delegate_Callback_Sorts_Int64_Buffer() {
        if !IsLibcCallable() {
            return // skip-not-fail on platforms without libc

        }
        // ADR-0095 §3 / Shape A: pass a G#-declared delegate annotated
        // with `@UnmanagedFunctionPointer(CallingConvention.Cdecl)` as
        // libc `qsort`'s comparator. The runtime synthesizes a stable
        // C-ABI thunk for the delegate. After sorting we read the
        // entries back and expect them in ascending order, proving the
        // managed comparator was actually invoked from native code.
        const source = `package P
import System
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
delegate Int64Comparer(a nint, b nint) int32;

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

Marshal.FreeHGlobal(buf)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "3${Environment.NewLine}7${Environment.NewLine}19${Environment.NewLine}42${Environment.NewLine}100${Environment.NewLine}",
            output
        )
    }

    @Fact
    func LibraryImport_Qsort_With_Delegate_Callback_Sorts_Int64_Buffer() {
        if !IsLibcCallable() {
            return
        }
        // ADR-0095 §3 / Shape A under @LibraryImport: same end-to-end
        // contract as the @DllImport case, but flows through the
        // outer-stub + inner-PInvoke pair emitted by the LibraryImport
        // path (ADR-0092). Both methods must carry compatible
        // signatures for the delegate argument so the marshaller can
        // synthesize the thunk at the inner boundary.
        const source = `package P
import System
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
delegate Int64Comparer(a nint, b nint) int32;

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

Marshal.FreeHGlobal(buf)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}3${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func DllImport_FunctionPointer_ReturnType_Encodes_As_FNPTR() {
        // ADR-0095 §3 / Shape B: a raw function-pointer return type
        // (`unmanaged[Cdecl] () -> void`) encodes as an
        // ELEMENT_TYPE_FNPTR (0x1B) signature blob. Verify the inner
        // signature byte sequence so a future regression that erases
        // the FNPTR encoding back to `nint` is caught at metadata
        // time, not just at runtime.
        const source = `package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "dlsym")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;`
        let tempDir = Directory.CreateTempSubdirectory("gs_761_fnptr_ret_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var found = false
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                let name = md.GetString(m.Name)
                if name != "native_dlsym" {
                    continue
                }
                let sig = md.GetBlobBytes(m.Signature)
                Assert.Contains(uint8(SignatureTypeCode.FunctionPointer), sig)
                found = true
            }
            Assert.True(found, "expected an emitted P/Invoke method named native_dlsym")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func DllImport_FunctionPointer_Parameter_Encodes_As_FNPTR() {
        // ADR-0095 §3 / Shape B for a parameter: the metadata blob
        // for a raw function-pointer parameter must contain
        // ELEMENT_TYPE_FNPTR (0x1B), not just the address-sized
        // IntPtr fallback.
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;`
        let tempDir = Directory.CreateTempSubdirectory("gs_761_fnptr_par_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var found = false
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                let name = md.GetString(m.Name)
                if name != "native_qsort" {
                    continue
                }
                let sig = md.GetBlobBytes(m.Signature)
                Assert.Contains(uint8(SignatureTypeCode.FunctionPointer), sig)
                found = true
            }
            Assert.True(found, "expected an emitted P/Invoke method named native_qsort")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func DelegateWith_UnmanagedFunctionPointer_Attribute_Emits_CustomAttribute_Row() {
        // ADR-0095 §4: the `@UnmanagedFunctionPointer` annotation on a
        // delegate declaration must flow into the emitted assembly as
        // a regular CustomAttribute row on the delegate TypeDef so
        // the CLR records the calling convention used to synthesize
        // the C-ABI thunk.
        const source = `package P
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
delegate MyCallback(a nint) int32;`
        let tempDir = Directory.CreateTempSubdirectory("gs_761_attr_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var foundAttr = false
            for th in md.TypeDefinitions {
                let td = md.GetTypeDefinition(th)
                if md.GetString(td.Name) != "MyCallback" {
                    continue
                }
                for ca in td.GetCustomAttributes() {
                    let attr = md.GetCustomAttribute(ca)
                    let ctorH = attr.Constructor
                    var ownerName string? = nil
                    if ctorH.Kind == HandleKind.MemberReference {
                        let mref = md.GetMemberReference(MemberReferenceHandle(ctorH))
                        if mref.Parent.Kind == HandleKind.TypeReference {
                            let tref = md.GetTypeReference(TypeReferenceHandle(mref.Parent))
                            ownerName = md.GetString(tref.Name)
                        }
                    }
                    if ownerName == "UnmanagedFunctionPointerAttribute" {
                        foundAttr = true
                    }
                }
            }
            Assert.True(foundAttr, "expected [UnmanagedFunctionPointer] CustomAttribute on the delegate TypeDef")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func IsLibcCallable() bool -> RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX)

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_761_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                CompileOrThrow(srcPath, outPath, target: "exe")
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileOrThrow(srcPath string, outPath string, target string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }
    }
}
