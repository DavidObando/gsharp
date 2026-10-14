// <copyright file="Issue1203SharedExternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// End-to-end emit coverage for ADR-0086 / issue #1203: a static
/// `@DllImport` extern declared inside a class's `shared { }` block
/// (the C# `static extern` equivalent) lowers to a CLR `Static` +
/// `PinvokeImpl` method with an `ImplMap` row. The bodyless static
/// member used to crash the compiler with GS9998; this pins the emitted
/// metadata, including the raw-pointer parameters allowed by the enclosing
/// `unsafe` class.
open class Issue1203SharedExternEmitTests {
    @Fact
    func StaticDllImportExtern_InUnsafeClass_EmitsPinvokeImplMethod() {
        const source = `package p
import System.Runtime.InteropServices

unsafe class C {
    shared {
        @DllImport("kernel32", SetLastError: true)
        func ReadFile(handle System.IntPtr, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_shared_extern_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var foundPInvoke = false
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                if md.GetString(m.Name) != "ReadFile" {
                    continue
                }
                foundPInvoke = true
                Assert.True((m.Attributes & MethodAttributes.Static) == MethodAttributes.Static)
                Assert.True((m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl)
                let import_ = m.GetImport()
                Assert.False(import_.Module.IsNil)
                Assert.Equal("kernel32", md.GetString(md.GetModuleReference(import_.Module).Name))
                Assert.Equal("ReadFile", md.GetString(import_.Name))
                Assert.True(
                    (import_.Attributes & MethodImportAttributes.SetLastError) == MethodImportAttributes.SetLastError
                )
                let declaringType = md.GetString(md.GetTypeDefinition(m.GetDeclaringType()).Name)
                Assert.Equal("C", declaringType)
            }
            Assert.True(foundPInvoke, "expected an emitted static P/Invoke method named ReadFile on class C")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
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
