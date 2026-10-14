// <copyright file="LetFieldEmitTests.cs" company="GSharp">
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

/// ADR-0067 / issue #694: emit tests for `let` fields on user-declared types.
/// A `let` field maps to a CLR `initonly` field, mirroring how
/// `readonly` fields behave in C#.
open class LetFieldEmitTests {
    @Fact
    func LetField_OnClass_EmitsAsInitOnly() {
        let source = `package P
import System

class Holder {
    public let Name string = "x"
    init() {}
}`
        let assembly = CompileToAssembly(source, target: "library")
        let holder = assembly.GetTypes().Single((t Type) -> t.Name == "Holder")
        let field FieldInfo? = holder.GetField("Name", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(field)
        Assert.Equal(typeof(string), field!!.FieldType)
        Assert.True(field!!.IsInitOnly, "`let` field should emit as CLR initonly.")
    }

    @Fact
    func VarField_OnClass_IsNotInitOnly() {
        let source = `package P
import System

class Holder {
    public var Name string = "x"
    init() {}
}`
        let assembly = CompileToAssembly(source, target: "library")
        let holder = assembly.GetTypes().Single((t Type) -> t.Name == "Holder")
        let field FieldInfo? = holder.GetField("Name", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(field)
        Assert.False(field!!.IsInitOnly, "`var` field should NOT be initonly.")
    }

    shared {
        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_let_field_emit_").FullName
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
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }
    }
}
