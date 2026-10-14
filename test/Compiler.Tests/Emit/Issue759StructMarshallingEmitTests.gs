// <copyright file="Issue759StructMarshallingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// End-to-end emit + execute coverage for ADR-0093 / issue #759 struct- and
/// class-marshalling. Exercises three angles:
/// - A blittable G# struct is emitted with the correct CLR
/// (cref:System.Reflection.TypeAttributes.SequentialLayout) flag, can flow through user code, and
/// contains no duplicate `[StructLayout]` / `[FieldOffset]` `CustomAttribute` rows (they are
/// pseudo-custom attributes — the runtime reconstructs them from the `ClassLayout` / `FieldLayout`
/// metadata tables).
/// - An explicit-layout union round-trips through pure managed code: writing one field and reading an
/// overlapping field returns the expected bit pattern, demonstrating that the emitted `FieldLayout`
/// rows are honoured by the CLR.
/// - A P/Invoke function whose return type is a blittable struct compiles, IL-verifies, and the
/// resulting assembly carries a `PinvokeImpl` method whose return type points at the struct.
open class Issue759StructMarshallingEmitTests {
    @Fact
    func Blittable_SequentialLayout_Struct_RoundTrips_In_Managed_Code() {
        const source = `package P
import System
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 3, Y: 4}
Console.WriteLine(p.X)
Console.WriteLine(p.Y)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}4${Environment.NewLine}", output)
    }

    @Fact
    func ExplicitLayout_Union_RoundTrips_Through_Overlapping_Fields() {
        // The two int32 halves of an explicit-layout union must overlap the
        // 64-bit field. Writing the halves and reading the QuadPart back
        // exercises the CLR layout engine's handling of the emitted
        // FieldLayout rows: an incorrect emit would either lose the overlap
        // (yielding 0 for QuadPart) or corrupt the high bytes.
        const source = `package P
import System
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 8)
struct LargeInteger {
    @FieldOffset(0) var LowPart uint32
    @FieldOffset(4) var HighPart int32
    @FieldOffset(0) var QuadPart int64
}

var v = LargeInteger{LowPart: 0u, HighPart: 0, QuadPart: 0L}
v.LowPart = 0x11223344u
v.HighPart = 0x55667788
Console.WriteLine(v.QuadPart)`
        let output = CompileAndRun(source)
        // 0x5566778811223344 = 6153737367135073092.
        Assert.Equal("6153737367135073092${Environment.NewLine}", output)
    }

    @Fact
    func Emitted_SequentialLayout_Struct_Has_No_CustomAttribute_Rows_For_StructLayout() {
        const source = `package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}`
        let tempDir = MakeTempDir("gs_pinvoke_struct_seq_")
        try {
            let (md, _) = CompileAndOpenMetadata(tempDir, source, target: "library")
            let pointHandle = FindTypeDef(md, "Point")
            Assert.False(pointHandle.IsNil, "expected a TypeDef named Point")
            let point = md.GetTypeDefinition(pointHandle)
            let layoutFlag = point.Attributes & TypeAttributes.LayoutMask
            Assert.Equal(TypeAttributes.SequentialLayout, layoutFlag)
            AssertNoPseudoCustomAttributeRow(md, point, "StructLayoutAttribute")
            AssertNoPseudoCustomAttributeRow(md, point, "FieldOffsetAttribute")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func Emitted_ExplicitLayout_Struct_Has_FieldLayout_Rows_And_No_Duplicate_Attributes() {
        const source = `package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 8)
struct LargeInteger {
    @FieldOffset(0) var LowPart uint32
    @FieldOffset(4) var HighPart int32
    @FieldOffset(0) var QuadPart int64
}`
        let tempDir = MakeTempDir("gs_pinvoke_struct_expl_")
        try {
            let (md, _) = CompileAndOpenMetadata(tempDir, source, target: "library")
            let typeHandle = FindTypeDef(md, "LargeInteger")
            Assert.False(typeHandle.IsNil, "expected a TypeDef named LargeInteger")
            let typeDef = md.GetTypeDefinition(typeHandle)
            let layoutFlag = typeDef.Attributes & TypeAttributes.LayoutMask
            Assert.Equal(TypeAttributes.ExplicitLayout, layoutFlag)
            // ClassLayout row: explicit Size=8.
            let classLayout = typeDef.GetLayout()
            Assert.False(classLayout.IsDefault, "expected ClassLayout row for explicit-layout struct with Size")
            Assert.Equal(8, classLayout.Size)
            // FieldLayout per field. Build a name -> offset map.
            let offsets = Dictionary[string, int32]()
            for fh in typeDef.GetFields() {
                let f = md.GetFieldDefinition(fh)
                let name = md.GetString(f.Name)
                offsets[name] = f.GetOffset()
            }
            Assert.Equal(0, offsets["LowPart"])
            Assert.Equal(4, offsets["HighPart"])
            Assert.Equal(0, offsets["QuadPart"])
            AssertNoPseudoCustomAttributeRow(md, typeDef, "StructLayoutAttribute")
            for fh in typeDef.GetFields() {
                AssertNoPseudoCustomAttributeRow(md, fh, "FieldOffsetAttribute")
            }
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func PInvoke_With_Blittable_Struct_Parameter_Emits_PinvokeImpl_And_Verifies() {
        // We do not actually invoke the native function — most stable libc
        // entry points take pointers rather than struct-by-value, and the
        // v1 P/Invoke surface (issue #728) does not yet expose `ref`
        // parameters. What we verify here is the *binding + emit + IL
        // verification* contract: a blittable struct is accepted as a
        // P/Invoke parameter type, the method definition carries
        // PinvokeImpl, and the produced assembly passes ilverify.
        const source = `package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}

@DllImport("libc", EntryPoint: "gsharp_test_no_such_symbol")
func AcceptPoint(p Point) int32;`
        let tempDir = MakeTempDir("gs_pinvoke_struct_param_")
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
                if md.GetString(m.Name) != "AcceptPoint" {
                    continue
                }
                found = true
                Assert.True(
                    (m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl,
                    "AcceptPoint should carry PinvokeImpl"
                )
                Assert.False(m.GetImport().Module.IsNil)
            }
            Assert.True(found, "expected an emitted P/Invoke method named AcceptPoint")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func FindTypeDef(md MetadataReader, name string) TypeDefinitionHandle {
            for h in md.TypeDefinitions {
                let td = md.GetTypeDefinition(h)
                if md.GetString(td.Name) == name {
                    return h
                }
            }
            return default(TypeDefinitionHandle)
        }

        private func AssertNoPseudoCustomAttributeRow(md MetadataReader, typeDef TypeDefinition, attrTypeName string) {
            for caH in typeDef.GetCustomAttributes() {
                let ca = md.GetCustomAttribute(caH)
                Assert.False(
                    CustomAttributeTypeNameMatches(md, ca, attrTypeName),
                    "unexpected CustomAttribute '$attrTypeName' on type '${md.GetString(typeDef.Name)}' (must be a pseudo-custom attribute row)"
                )
            }
        }

        private func AssertNoPseudoCustomAttributeRow(
            md MetadataReader,
            fieldHandle FieldDefinitionHandle,
            attrTypeName string
        ) {
            let field = md.GetFieldDefinition(fieldHandle)
            for caH in field.GetCustomAttributes() {
                let ca = md.GetCustomAttribute(caH)
                Assert.False(
                    CustomAttributeTypeNameMatches(md, ca, attrTypeName),
                    "unexpected CustomAttribute '$attrTypeName' on field '${md.GetString(field.Name)}' (must be a pseudo-custom attribute row)"
                )
            }
        }

        private func CustomAttributeTypeNameMatches(md MetadataReader, ca CustomAttribute, typeName string) bool {
            switch ca.Constructor.Kind {
                case HandleKind.MemberReference {
                    let mref = md.GetMemberReference(MemberReferenceHandle(ca.Constructor))
                    if mref.Parent.Kind == HandleKind.TypeReference {
                        let tref = md.GetTypeReference(TypeReferenceHandle(mref.Parent))
                        return md.GetString(tref.Name) == typeName
                    }
                    return false
                }
                case HandleKind.MethodDefinition {
                    let mdef = md.GetMethodDefinition(MethodDefinitionHandle(ca.Constructor))
                    let declaring = md.GetTypeDefinition(mdef.GetDeclaringType())
                    return md.GetString(declaring.Name) == typeName
                }
                default {
                    return false
                }
            }
        }

        private func CompileAndOpenMetadata(tempDir string, source string, target string)(
            Md MetadataReader,
            AssemblyPath string
        ) {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target)
            IlVerifier.Verify(outPath)
            let pe = PEReader(File.OpenRead(outPath))
            return (pe.GetMetadataReader(), outPath)
        }

        private func MakeTempDir(prefix string) string -> Directory.CreateTempSubdirectory(prefix).FullName

        private func CompileAndRun(source string) string {
            let tempDir = MakeTempDir("gs_pinvoke_struct_emit_")
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
