// <copyright file="Issue1358ImportedPointerParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.IO
import Xunit

/// Issue #1358: imported BCL methods whose parameters are `T*` or
/// `void*` must compile through emit after binding selects them.
open class Issue1358ImportedPointerParameterEmitTests {
    @Fact
    func Vector256Load_GenericPointerParameter_Compiles() {
        const source = `package P
import System.Runtime.Intrinsics

class C {
    unsafe func G(p *uint8) {
        let v = Vector256.Load(p)
    }
}`
        Compile(source)
    }

    @Fact
    func UnsafeRead_VoidPointerParameter_Compiles() {
        const source = `package P
import System.Runtime.CompilerServices

class C {
    unsafe func G(p *uint8) {
        let v = Unsafe.Read[uint8](p)
    }
}`
        Compile(source)
    }

    shared {
        private func Compile(source string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1358_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
