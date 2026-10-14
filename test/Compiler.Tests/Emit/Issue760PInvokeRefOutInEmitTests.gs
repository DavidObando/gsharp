// <copyright file="Issue760PInvokeRefOutInEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// End-to-end emit + execute + ilverify coverage for ADR-0094 / issue #760 —
/// P/Invoke `ref`/`out`/`in` parameter marshalling. Exercises
/// both `@DllImport` and `@LibraryImport` against real libc
/// entry points so the IL signature, ImplMap row, and runtime marshalling
/// all line up.
open class Issue760PInvokeRefOutInEmitTests {
    @Fact
    func DllImport_RefInt64_LibcTime_WritesBack_Through_RefSlot() {
        if !IsLibcCallable() {
            return // skip-not-fail on platforms without libc

        }
        // libc `time(time_t *t)` returns the current Unix time and writes
        // the same value through the pointer. After the call:
        //   rc > 0   (time is past 1970)
        //   rc == t  (the byref slot received the same value)
        const source = `package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;

var t = 0L
var rc = native_time(ref t)
Console.WriteLine(rc > 0L)
Console.WriteLine(rc == t)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func DllImport_RefStruct_ClockGetTime_WritesBack_Through_RefStructSlot() {
        if !IsLibcCallable() {
            return
        }
        // libc `clock_gettime(CLOCK_REALTIME=0, struct timespec *)` writes
        // the current epoch time into the byref slot. `struct timespec`
        // on every supported 64-bit POSIX platform is two 8-byte words
        // (`time_t tv_sec`, `long tv_nsec`), which the G# `TimeSpec`
        // struct mirrors. CLOCK_REALTIME == 0 is portable across glibc
        // and Apple libc (CLOCK_MONOTONIC's numeric value differs).
        const source = `package P
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
Console.WriteLine(ts.tv_sec > 0L)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func DllImport_OutPrimitive_LibcTime_AcceptsOutModifier() {
        if !IsLibcCallable() {
            return
        }
        // `out t` requires definite assignment by the callee. libc `time`
        // writes its return value through the pointer, satisfying the
        // out contract for blittable primitives.
        const source = `package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "time")
func native_time(out t int64) int64;

var t = 0L
var rc = native_time(out t)
Console.WriteLine(rc == t)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func DllImport_InPrimitive_IsAccepted_And_Emits() {
        if !IsLibcCallable() {
            return
        }
        // `in` is a read-only byref. The callee gets a pointer it must not
        // mutate. libc `time` ignores the input and overwrites the pointee
        // with the current time, but the managed slot is still passed by
        // address. We compile + IL-verify + run to confirm the signature
        // shape is accepted end to end.
        const source = `package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "time")
func native_time(in t int64) int64;

var t = 0L
var rc = native_time(in t)
Console.WriteLine(rc > 0L)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func LibraryImport_RefInt64_LibcTime_WritesBack_Through_RefSlot() {
        if !IsLibcCallable() {
            return
        }
        // The @LibraryImport outer stub forwards each byref parameter by
        // loading the managed pointer slot (ldarg.s with byref type) and
        // calling the inner blittable P/Invoke. No marshalling stub is
        // required for blittable primitives — the IL just hands the same
        // address to the inner call.
        const source = `package P
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;

var t = 0L
var rc = native_time(ref t)
Console.WriteLine(rc > 0L)
Console.WriteLine(rc == t)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Theory
    @InlineData("DllImport")
    @InlineData("LibraryImport")
    func ExplicitlyMarshaled_RefBool_RandR_WritesBack(importAttribute string) {
        if !IsLibcCallable() {
            return
        }
        // POSIX rand_r consumes and updates an unsigned int*. UnmanagedType.Bool
        // gives the managed bool slot the same four-byte ABI representation.
        let source = (`package P
import System
import System.Runtime.InteropServices

@` + "$importAttribute" + `("libc", EntryPoint: "rand_r")
func native_rand_r(@MarshalAs(UnmanagedType.Bool) ref seed bool) int32;

var seed = false
var rc = native_rand_r(ref seed)
Console.WriteLine(rc != 0)
Console.WriteLine(seed)`)
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func DllImport_RefParameter_EmitsByRefSignature_In_ImplMap() {
        if !IsLibcCallable() {
            return
        }
        // Read the emitted MethodDef signature and confirm the parameter
        // is encoded with the ELEMENT_TYPE_BYREF sentinel before the
        // pointee. Without this byte, the runtime would reinterpret the
        // managed pointer as a 64-bit value and corrupt the call frame.
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;`
        let tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_ref_meta_").FullName
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
                if md.GetString(m.Name) != "native_time" {
                    continue
                }
                found = true
                Assert.True(
                    (m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl,
                    "native_time should carry PinvokeImpl"
                )
                let sigBytes = md.GetBlobBytes(m.Signature)
                // The signature blob layout we care about is:
                // [calling-conv][param-count][return-type][ELEMENT_TYPE_BYREF=0x10][pointee=I8].
                // The ByRef sentinel appears immediately before the pointee type.
                Assert.Contains(uint8(SignatureTypeCode.ByReference), sigBytes)
            }
            Assert.True(found, "expected an emitted P/Invoke method named native_time")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func LibraryImport_RefParameter_BothInnerAndOuter_Encode_ByRef() {
        if !IsLibcCallable() {
            return
        }
        // @LibraryImport emits two MethodDefs — an outer managed stub and a
        // hidden inner P/Invoke. For ref-kind parameters both must carry
        // the ELEMENT_TYPE_BYREF sentinel so the address forwarded from
        // outer.ldarg to inner.call is interpreted correctly at the
        // unmanaged boundary.
        const source = `package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;`
        let tempDir = Directory.CreateTempSubdirectory("gs_libimp_ref_meta_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var outerWithByRef = 0
            var innerWithByRef = 0
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                let name = md.GetString(m.Name)
                let sigBytes = md.GetBlobBytes(m.Signature)
                if name == "native_time" && Enumerable.Contains(sigBytes, uint8(SignatureTypeCode.ByReference)) {
                    outerWithByRef++
                } else if name.Contains("native_time") && name.Contains("PInvoke") && Enumerable.Contains(
                    sigBytes,
                    uint8(SignatureTypeCode.ByReference)
                ) {
                    innerWithByRef++
                }
            }
            Assert.True(outerWithByRef >= 1, "outer LibraryImport stub should encode ref parameter as byref")
            Assert.True(innerWithByRef >= 1, "inner LibraryImport PInvoke should encode ref parameter as byref")
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
            let tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_refout_emit_").FullName
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
