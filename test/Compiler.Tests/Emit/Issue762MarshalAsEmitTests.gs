// <copyright file="Issue762MarshalAsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import MetadataParameter = System.Reflection.Metadata.Parameter
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// End-to-end emit + ilverify (+ run on POSIX hosts) coverage for
/// ADR-0096 / issue #762 — per-parameter `@MarshalAs(UnmanagedType.…)`
/// overrides on P/Invoke declarations. For each accepted form the
/// test compiles a P/Invoke declaration, ilverifies the assembly, then
/// inspects the metadata to confirm `ParameterAttributes.HasFieldMarshal`
/// is set and the `FieldMarshal` blob's first byte equals the
/// expected ECMA-335 II.23.4 `UnmanagedType` token.
///
/// The execution-time test (LPArray with SizeParamIndex against libc
/// `memcpy`) is cross-platform: it runs on Linux and macOS and is
/// skipped on Windows where libc is not available under that name.
open class Issue762MarshalAsEmitTests {
    @Theory
    @InlineData("LPStr", "string", int32(20))
    @InlineData("LPWStr", "string", int32(21))
    @InlineData("LPUTF8Str", "string", int32(48))
    @InlineData("BStr", "string", int32(19))
    @InlineData("Bool", "bool", int32(2))
    @InlineData("VariantBool", "bool", int32(37))
    @InlineData("I1", "int8", int32(3))
    @InlineData("U1", "uint8", int32(4))
    @InlineData("I2", "int16", int32(5))
    @InlineData("U2", "uint16", int32(6))
    @InlineData("I4", "int32", int32(7))
    @InlineData("U4", "uint32", int32(8))
    @InlineData("I8", "int64", int32(9))
    @InlineData("U8", "uint64", int32(10))
    @InlineData("SysInt", "nint", int32(31))
    @InlineData("SysUInt", "nuint", int32(32))
    func MarshalAs_BareForm_StampsHasFieldMarshalAndCorrectBlobByte(
        unmanagedType string,
        paramTypeText string,
        expectedByte int32
    ) {
        let source = (`
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "x")
func native_x(@MarshalAs(UnmanagedType.` + "$unmanagedType" + `) p ` + "$paramTypeText" + `) void;
`)
        VerifyMarshalAsBlob(
            source,
            functionName: "native_x",
            parameterName: "p",
            expectedFirstBlobByte: uint8(expectedByte),
            expectedBlobLength: 1
        )
    }

    @Fact
    func MarshalAs_I4_OnBool_StampsHasFieldMarshal() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;
`
        VerifyMarshalAsBlob(
            source,
            functionName: "native_set_flag",
            parameterName: "on",
            expectedFirstBlobByte: 0x07,
            expectedBlobLength: 1
        )
    }

    @Fact
    func MarshalAs_Bool_OnRefBool_EmitsByRefSignatureAndFieldMarshal() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.Bool) ref flag bool) int32;
`
        let tempDir = Directory.CreateTempSubdirectory("gs_2554_ref_bool_").FullName
        try {
            let (_, outPath) = WriteAndCompile(tempDir, source)
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            let method = FindMethod(md, "native_set_flag")
            Assert.Contains(uint8(SignatureTypeCode.ByReference), md.GetBlobBytes(method.Signature))
            let parameter = method
                .GetParameters()
                .Select(md.GetParameter)
                .Single((p MetadataParameter) -> md.GetString(p.Name) == "flag")
            Assert.True((parameter.Attributes & ParameterAttributes.HasFieldMarshal) != 0)
            Assert.Equal([]uint8{uint8(UnmanagedType.Bool)}, md.GetBlobBytes(parameter.GetMarshallingDescriptor()))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func MarshalAs_Bool_OnLibraryImportRefBool_ReachesInnerPInvoke() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libfoo", EntryPoint: "set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.Bool) ref flag bool) int32;
`
        let tempDir = Directory.CreateTempSubdirectory("gs_2554_lib_ref_bool_").FullName
        try {
            let (_, outPath) = WriteAndCompile(tempDir, source)
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            let method = md
                .MethodDefinitions
                .Select(md.GetMethodDefinition)
                .Single(
                (m MethodDefinition) -> md.GetString(m.Name).Contains("native_set_flag") &&
                    (m.Attributes & MethodAttributes.PinvokeImpl) != 0
            )
            let parameter = method
                .GetParameters()
                .Select(md.GetParameter)
                .Single((p MetadataParameter) -> md.GetString(p.Name) == "flag")
            Assert.True((parameter.Attributes & ParameterAttributes.HasFieldMarshal) != 0)
            Assert.Equal([]uint8{uint8(UnmanagedType.Bool)}, md.GetBlobBytes(parameter.GetMarshallingDescriptor()))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func MarshalAs_LPArray_WithSizeParamIndex_EncodesAsLPArrayMaxParam() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "sum_buf")
func native_sum_buf(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;
`
        let blob = ReadMarshalAsBlob(source, functionName: "native_sum_buf", parameterName: "buf")
        Assert.Equal(0x2a, int32(blob[0])) // NATIVE_TYPE_ARRAY
        Assert.Equal(0x50, int32(blob[1])) // NATIVE_TYPE_MAX (ArraySubType unspecified)
        Assert.Equal(0x01, int32(blob[2])) // compressed SizeParamIndex = 1
        Assert.Equal(3, blob.Length)
    }

    @Fact
    func MarshalAs_ByValArray_WithSizeConst_EncodesAsFixedArray() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "inline")
func native_inline(@MarshalAs(UnmanagedType.ByValArray, SizeConst: 16) buf []uint8) void;
`
        let blob = ReadMarshalAsBlob(source, functionName: "native_inline", parameterName: "buf")
        Assert.Equal(0x1e, int32(blob[0])) // NATIVE_TYPE_FIXEDARRAY
        Assert.Equal(0x10, int32(blob[1])) // compressed SizeConst = 16
        Assert.Equal(2, blob.Length)
    }

    @Fact
    func MarshalAs_ByValTStr_WithSizeConst_EncodesAsFixedSysstring() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "take_str")
func native_take_str(@MarshalAs(UnmanagedType.ByValTStr, SizeConst: 8) s string) void;
`
        let blob = ReadMarshalAsBlob(source, functionName: "native_take_str", parameterName: "s")
        Assert.Equal(0x17, int32(blob[0])) // NATIVE_TYPE_FIXEDSYSSTRING
        Assert.Equal(0x08, int32(blob[1])) // compressed SizeConst = 8
        Assert.Equal(2, blob.Length)
    }

    @Fact
    func MarshalAs_SafeArray_WithSafeArraySubType_EncodesVariantType() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "take_sa")
func native_take_sa(@MarshalAs(UnmanagedType.SafeArray, SafeArraySubType: VarEnum.VT_I4) sa []int32) void;
`
        let blob = ReadMarshalAsBlob(source, functionName: "native_take_sa", parameterName: "sa")
        Assert.Equal(0x1d, int32(blob[0])) // NATIVE_TYPE_SAFEARRAY
        Assert.Equal(uint8(VarEnum.VT_I4), blob[1]) // VT_I4 == 3
        Assert.Equal(2, blob.Length)
    }

    @Fact
    func MarshalAs_Struct_EncodesAsStructByte() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Pt {
    var x int32
    var y int32
}

@DllImport("libfoo", EntryPoint: "take_pt")
func native_take_pt(@MarshalAs(UnmanagedType.Struct) p Pt) void;
`
        let blob = ReadMarshalAsBlob(source, functionName: "native_take_pt", parameterName: "p")
        Assert.Single(blob) // NATIVE_TYPE_STRUCT (single byte)
        Assert.Equal(0x1b, int32(blob[0]))
    }

    @Fact
    func MarshalAs_LibraryImport_NonString_StampsHasFieldMarshalOnOuterParam() {
        // ADR-0096 §5 + ADR-0092 §6.x — @MarshalAs on a @LibraryImport
        // non-string parameter must flow into the outer-stub parameter
        // (the user-visible method) so the runtime marshaller picks up
        // the override at the inner P/Invoke boundary.
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libfoo", EntryPoint: "sum")
func native_sum(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;
`
        let blob = ReadMarshalAsBlob(source, functionName: "native_sum", parameterName: "buf")
        Assert.Equal(0x2a, int32(blob[0])) // NATIVE_TYPE_ARRAY

    }

    @Fact
    func MarshalAs_PseudoCustomAttribute_NoCustomAttributeRowOnParam() {
        // ADR-0096 §5: @MarshalAs is pseudo-custom; the emitter must not
        // also write a CustomAttribute row for it on the Param row. The
        // FieldMarshal table row is the entire metadata representation.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "x")
func native_x(@MarshalAs(UnmanagedType.LPWStr) s string) void;
`
        let tempDir = Directory.CreateTempSubdirectory("gs_762_no_ca_").FullName
        try {
            let (srcPath, outPath) = WriteAndCompile(tempDir, source)
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            let methodDef = FindMethod(md, "native_x")
            for ph in methodDef.GetParameters() {
                let pdef = md.GetParameter(ph)
                if md.GetString(pdef.Name) != "s" {
                    continue
                }
                Assert.True((pdef.Attributes & ParameterAttributes.HasFieldMarshal) != 0, "expected HasFieldMarshal")
                for ca in pdef.GetCustomAttributes() {
                    let attr = md.GetCustomAttribute(ca)
                    let ctorH = attr.Constructor
                    if ctorH.Kind == HandleKind.MemberReference {
                        let mref = md.GetMemberReference(MemberReferenceHandle(ctorH))
                        if mref.Parent.Kind == HandleKind.TypeReference {
                            let tref = md.GetTypeReference(TypeReferenceHandle(mref.Parent))
                            let name = md.GetString(tref.Name)
                            Assert.NotEqual("MarshalAsAttribute", name)
                        }
                    }
                }
            }
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func MarshalAs_LPArray_SizeParamIndex_MemcpyEndToEnd() {
        if !IsLibcCallable() {
            return // skip-not-fail on Windows.

        }
        // ADR-0096 / issue #762 end-to-end: pass a managed `[]int32`
        // through libc memcpy using `@MarshalAs(UnmanagedType.LPArray,
        // SizeParamIndex: …)` so the runtime knows the source array
        // length. Read the written bytes back from native memory to
        // prove the marshaller honoured the override.
        const source = `package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "memcpy")
func native_memcpy(
    dest nint,
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 2) src []int32,
    n nuint) nint;

let dest = Marshal.AllocHGlobal(16)
let src = []int32{11, 22, 33, 44}
native_memcpy(dest, src, UIntPtr(16))

Console.WriteLine(Marshal.ReadInt32(dest, 0))
Console.WriteLine(Marshal.ReadInt32(dest, 4))
Console.WriteLine(Marshal.ReadInt32(dest, 8))
Console.WriteLine(Marshal.ReadInt32(dest, 12))

Marshal.FreeHGlobal(dest)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}44${Environment.NewLine}",
            output
        )
    }

    shared {
        private func VerifyMarshalAsBlob(
            source string,
            functionName string,
            parameterName string,
            expectedFirstBlobByte uint8,
            expectedBlobLength int32
        ) {
            let blob = ReadMarshalAsBlob(source, functionName, parameterName)
            Assert.Equal(expectedFirstBlobByte, blob[0])
            if expectedBlobLength == 1 {
                Assert.Single(blob)
            } else {
                Assert.Equal(expectedBlobLength, blob.Length)
            }
        }

        private func ReadMarshalAsBlob(source string, functionName string, parameterName string)[]uint8 {
            let tempDir = Directory.CreateTempSubdirectory("gs_762_blob_").FullName
            try {
                let (srcPath, outPath) = WriteAndCompile(tempDir, source)
                IlVerifier.Verify(outPath)
                using let pe = PEReader(File.OpenRead(outPath))
                let md = pe.GetMetadataReader()
                let methodDef = FindMethod(md, functionName)
                for ph in methodDef.GetParameters() {
                    let pdef = md.GetParameter(ph)
                    if md.GetString(pdef.Name) != parameterName {
                        continue
                    }
                    Assert.True(
                        (pdef.Attributes & ParameterAttributes.HasFieldMarshal) != 0,
                        "expected ParameterAttributes.HasFieldMarshal on '$parameterName'"
                    )
                    let marshallingHandle = pdef.GetMarshallingDescriptor()
                    Assert.False(marshallingHandle.IsNil, "expected a FieldMarshal blob on the parameter")
                    return md.GetBlobBytes(marshallingHandle)
                }
                throw InvalidOperationException("parameter '$parameterName' not found on '$functionName'")
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func FindMethod(md MetadataReader, name string) MethodDefinition {
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                if md.GetString(m.Name) == name {
                    return m
                }
            }
            throw InvalidOperationException("method '$name' not found")
        }

        private func WriteAndCompile(tempDir string, source string)(SrcPath string, OutPath string) {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            return (srcPath, outPath)
        }

        private func IsLibcCallable() bool -> RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX)

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_762_run_").FullName
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
