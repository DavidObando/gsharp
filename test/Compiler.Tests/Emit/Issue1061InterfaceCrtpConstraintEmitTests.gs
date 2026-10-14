// <copyright file="Issue1061InterfaceCrtpConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.IO
import Xunit

/// Issue #1061: end-to-end CLR emit + ilverify coverage for a self-referential /
/// CRTP constraint on an INTERFACE declaration (the interface's own type
/// parameter constrained by the interface being declared). A missing or garbled
/// GenericParamConstraint metadata row pointing at the interface would fail
/// ilverify, so a clean verification confirms the constraint binds and emits
/// correctly — the same way the class CRTP shape does (issue #1056).
open class Issue1061InterfaceCrtpConstraintEmitTests {
    @Fact
    func Library_SelfReferentialInterfaceConstraint_BareName_PassesIlVerify() {
        let source = `package p
interface IData[T IData] {
    func Write(d int32);
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_SelfReferentialInterfaceConstraint_Crtp_PassesIlVerify() {
        let source = `package p
interface IData[TData IData[TData]] {
    func Write(d int32);
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_CrtpInterfaceWithConcreteImplementer_PassesIlVerify() {
        // The CRTP interface together with a concrete implementer that supplies
        // itself as the type argument (`class C : IData[C]`). The implementer
        // must satisfy the self-referential constraint, and the produced
        // assembly (interface TypeDef + GenericParamConstraint + implementing
        // class) must verify.
        let source = `package p
interface IData[T IData[T]] {
    func Write(d int32);
}
class C : IData[C] {
    func Write(d int32) { }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1061_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func RunCompiler(args[]string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
