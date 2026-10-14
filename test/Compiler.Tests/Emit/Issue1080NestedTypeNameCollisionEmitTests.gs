// <copyright file="Issue1080NestedTypeNameCollisionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #1080: two nested types that share a simple name across DIFFERENT
/// enclosing types — and a nested type whose simple name matches a package-level
/// type — must no longer collide with `GS0102`. Each retained type must
/// emit as its own CLR (nested) TypeDef, pass ilverify, and run. Follow-up to
/// #1069.
open class Issue1080NestedTypeNameCollisionEmitTests {
    @Fact
    func SameNestedSimpleName_DifferentOuters_BothEmitAsDistinctNestedTypes() {
        let asm = CompileToLibrary(`package P

open class A {
    func Make() int32 {
        let i = Inner{X: 1}
        return i.X
    }

    struct Inner { var X int32 }
}

open class B {
    func Other() int32 {
        let j = Probe{Y: 2}
        return j.Y
    }

    struct Inner { var Z int32 }

    struct Probe { var Y int32 }
}`)
        // Both `Inner` nested structs emit as distinct CLR nested types, each
        // declared in its own enclosing type — they no longer collide (#1080).
        let inners = asm.GetTypes().Where((t Type) -> t.Name == "Inner" && t.IsNested).ToList()
        Assert.Equal(2, inners.Count)
        Assert.Contains(inners, (t Type) -> t.DeclaringType!!.Name == "A")
        Assert.Contains(inners, (t Type) -> t.DeclaringType!!.Name == "B")
    }

    @Fact
    func PackageLevelType_VersusNestedDataStruct_SameName_BothEmit() {
        let asm = CompileToLibrary(`package P

class SampleEntry { var A int32 }

class SttsBox {
    data struct SampleEntry(FrameCount uint32, FrameDelta uint32) { }
}`)
        let topLevel = asm.GetTypes().Single((t Type) -> t.Name == "SampleEntry" && !t.IsNested)
        Assert.Null(topLevel.DeclaringType)
        let nested = asm.GetTypes().Single((t Type) -> t.Name == "SampleEntry" && t.IsNested)
        Assert.Equal("SttsBox", nested.DeclaringType!!.Name)
    }

    shared {
        private func CompileToLibrary(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1080_lib_").FullName
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
            return EmittedFixture.Load(outPath)
        }
    }
}
