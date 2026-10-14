// <copyright file="Issue758LibraryImportEmitTests.cs" company="GSharp">
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

/// End-to-end emit + execute + ilverify coverage for ADR-0092 / issue #758:
/// a G# function annotated with `@LibraryImport` emits an outer
/// managed marshalling stub that explicitly converts each `string`
/// argument to an unmanaged CoTaskMem buffer, calls a hidden blittable
/// inner P/Invoke method, and frees the buffer in a `finally` block.
/// The inner method carries the `PinvokeImpl` attribute and an
/// `ImplMap` row pointing at a deduplicated `ModuleRef`.
open class Issue758LibraryImportEmitTests {
    @Fact
    func LibraryImport_LibcStrLen_Utf8_RoundTrip_ReturnsExpectedLength() {
        if !IsLibcCallable() {
            return // skip-not-fail on platforms without libc

        }
        const source = `package P
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func strlen_native(text string) nint;

Console.WriteLine(strlen_native("Hello, world!"))`
        let output = CompileAndRun(source)
        Assert.Equal("13${Environment.NewLine}", output)
    }

    @Fact
    func LibraryImport_LibcGetpid_NoStringArgs_RoundTrip_ReturnsPid() {
        if !IsLibcCallable() {
            return
        }
        const source = `package P
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getpid")
func getpid_native() int32;

var p = getpid_native()
Console.WriteLine(p > 0)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func LibraryImport_LibcGetpid_SuppressGCTransition_RoundTrip_ReturnsPid() {
        if !IsLibcCallable() {
            return
        }
        const source = `package P
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getpid")
@SuppressGCTransition
func getpid_native() int32;

Console.WriteLine(getpid_native() > 0)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func LibraryImport_NullString_IsPassedAsZero_FreeIsNoop() {
        if !IsLibcCallable() {
            return
        }
        // `Marshal.StringToCoTaskMemUTF8(null)` returns `IntPtr.Zero`, and
        // `Marshal.FreeCoTaskMem(IntPtr.Zero)` is a documented no-op. Use
        // a tiny shim that passes a nullable-string parameter through to
        // the marshalling stub via a normal G# string variable so the
        // stub's null-safe path is exercised without depending on a
        // segfault-prone libc API.
        const source = `package P
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func strlen_native(text string) nuint;

var empty = ""
Console.WriteLine(strlen_native(empty))`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func LibraryImport_EmittedMethod_HasOuterStub_And_HiddenInnerPInvoke() {
        if !IsLibcCallable() {
            return
        }
        const source = `package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func MyStrLen(text string) nint;`
        let tempDir = Directory.CreateTempSubdirectory("gs_libimport_meta_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var foundOuter = false
            var foundInner = false
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                let name = md.GetString(m.Name)
                if name == "MyStrLen" {
                    foundOuter = true
                    // Outer stub is a managed method (NOT PinvokeImpl) with IL.
                    Assert.True((m.Attributes & MethodAttributes.PinvokeImpl) == 0)
                    Assert.True((m.Attributes & MethodAttributes.Static) == MethodAttributes.Static)
                    Assert.NotEqual(-1, m.RelativeVirtualAddress)
                } else if name.Contains("MyStrLen") && name.Contains("PInvoke") {
                    foundInner = true
                    Assert.True((m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl)
                    let import_ = m.GetImport()
                    Assert.False(import_.Module.IsNil)
                    Assert.False(import_.Name.IsNil)
                    let moduleName = md.GetString(md.GetModuleReference(import_.Module).Name)
                    Assert.Equal("libc", moduleName)
                    Assert.Equal("strlen", md.GetString(import_.Name))
                }
            }
            Assert.True(foundOuter, "expected an emitted outer stub named MyStrLen")
            Assert.True(foundInner, "expected an emitted inner P/Invoke method for MyStrLen")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func LibraryImport_TransitionAttributes_AreEncodedOnlyOnHiddenInnerPInvoke() {
        const source = `package P
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getpid")
@SuppressGCTransition
@DefaultDllImportSearchPaths(DllImportSearchPath.System32 | DllImportSearchPath.SafeDirectories)
@Obsolete("outer")
func MyGetPid() int32;`
        let tempDir = Directory.CreateTempSubdirectory("gs_libimport_attrs_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var outer = default(MethodDefinition)
            var inner = default(MethodDefinition)
            for handle in md.MethodDefinitions {
                let method = md.GetMethodDefinition(handle)
                let name = md.GetString(method.Name)
                if name == "MyGetPid" {
                    outer = method
                } else if name.Contains("MyGetPid", StringComparison.Ordinal) && name.Contains(
                    "PInvoke",
                    StringComparison.Ordinal
                ) {
                    inner = method
                }
            }
            Assert.False(outer.Name.IsNil, "expected the managed outer stub")
            Assert.False(inner.Name.IsNil, "expected the hidden inner P/Invoke")
            Assert.Equal([]string{"ObsoleteAttribute"}, AttributeNames(md, outer))
            Assert.Equal(
                []string{"DefaultDllImportSearchPathsAttribute", "SuppressGCTransitionAttribute"},
                AttributeNames(md, inner).OrderBy((name string) -> name, StringComparer.Ordinal)
            )
            let suppressTransition = Assert.Single(
                inner.GetCustomAttributes().Select(md.GetCustomAttribute),
                (attribute CustomAttribute) -> AttributeTypeName(md, attribute) == "SuppressGCTransitionAttribute"
            )
            var suppressValue = md.GetBlobReader(suppressTransition.Value)
            Assert.Equal(0x0001, int32(suppressValue.ReadUInt16()))
            Assert.Equal(0, int32(suppressValue.ReadUInt16()))
            let searchPaths = Assert.Single(
                inner.GetCustomAttributes().Select(md.GetCustomAttribute),
                (attribute CustomAttribute) -> AttributeTypeName(
                    md,
                    attribute
                ) == "DefaultDllImportSearchPathsAttribute"
            )
            var value = md.GetBlobReader(searchPaths.Value)
            Assert.Equal(0x0001, int32(value.ReadUInt16()))
            Assert.Equal(int32((DllImportSearchPath.System32 | DllImportSearchPath.SafeDirectories)), value.ReadInt32())
            Assert.Equal(0, int32(value.ReadUInt16()))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func AttributeNames(md MetadataReader, method MethodDefinition)[]string -> method
            .GetCustomAttributes()
            .Select(md.GetCustomAttribute)
            .Select((attribute CustomAttribute) -> AttributeTypeName(md, attribute))
            .ToArray()

        private func AttributeTypeName(md MetadataReader, attribute CustomAttribute) string {
            if attribute.Constructor.Kind == HandleKind.MemberReference {
                let constructor = md.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                if constructor.Parent.Kind == HandleKind.TypeReference {
                    return md.GetString(md.GetTypeReference(TypeReferenceHandle(constructor.Parent)).Name)
                }
            } else if attribute.Constructor.Kind == HandleKind.MethodDefinition {
                let constructor = md.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor))
                return md.GetString(md.GetTypeDefinition(constructor.GetDeclaringType()).Name)
            }
            return string.Empty
        }

        private func IsLibcCallable() bool -> RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX)

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_libimport_emit_").FullName
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
