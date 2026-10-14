// <copyright file="Issue2338GenericInlineStructCompareEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.IO
import Xunit

/// Cluster-A guardrail (self-instantiation token drift): the inline-struct
/// `==`/`!=` compare path in `MethodBodyEmitter.EmitBinary`
/// must resolve its field token through `ResolveFieldToken` so a
/// <em>generic</em> inline struct emits a self-instantiation
/// `MemberRef` rather than a bare open `FieldDef`. A bare
/// `FieldDef` makes ILVerify report "found ref Box<T0>, expected
/// ref Box". This mirrors the recurring token-drift antipattern fixed at
/// other call sites (#989/#1611/#1055/#2337/#2338).
open class Issue2338GenericInlineStructCompareEmitTests {
    @Fact
    func GenericInlineStruct_EqualityCompare_EmitsVerifiableIl() {
        let source = `package MyLib
import System

inline struct Box[T](value T)

func AreEqual(a Box[int32], b Box[int32]) bool -> a == b
func AreNotEqual(a Box[int32], b Box[int32]) bool -> a != b`
        // CompileAndVerify asserts gsc succeeds AND IlVerifier.Verify passes,
        // which is precisely what the bare-FieldDef bug violated.
        CompileAndVerify(source)
    }

    @Fact
    func NonGenericInlineStruct_EqualityCompare_StillVerifies() {
        // Control: the non-generic path must keep emitting the bare FieldDef
        // and remain verifiable after the reroute.
        let source = `package MyLib
import System

inline struct UserId(value int32)

func AreEqual(a UserId, b UserId) bool -> a == b`
        CompileAndVerify(source)
    }

    shared {
        private func CompileAndVerify(source string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_generic_inline_cmp_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            IlVerifier.Verify(outPath)
        }
    }
}
