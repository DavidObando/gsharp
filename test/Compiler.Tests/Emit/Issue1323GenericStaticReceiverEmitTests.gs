// <copyright file="Issue1323GenericStaticReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #1323: a generic static member-access receiver
/// `Type[TypeArg].StaticMember(...)` previously only parsed when
/// `TypeArg` was a SIMPLE name. When the single type argument was nullable
/// (`T?`), an array/slice (`[]T`), or a nested generic
/// (`List[T]`) the parser failed with GS0005 because the #942 trailing-`.`
/// rule treated `Name[singleArg].Member` as an indexer-then-member access,
/// and those argument shapes are not legal index expressions.
///
/// The fix commits to a generic call site on a trailing `.` when the
/// single type argument is unambiguously type-shaped, and emits a
/// `GenericNameExpression` receiver the binder resolves to the closed
/// construction. These end-to-end tests lock the parse → bind → emit → execute
/// chain for the constructed-generic static-call receiver.
open class Issue1323GenericStaticReceiverEmitTests {
    @Fact
    func NullableTypeArg_StaticCall_Executes() {
        // `Box[int32?].Make(41)` — nullable single type argument.
        let source = `package P
struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
public var result = Box[int32?].Make(41)`
        Assert.Equal(42, RunAndGetIntResult(source))
    }

    @Fact
    func ArrayTypeArg_StaticCall_Executes() {
        // `Box[[]int32].Make(9)` — array/slice single type argument.
        let source = `package P
struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
public var result = Box[[]int32].Make(9)`
        Assert.Equal(10, RunAndGetIntResult(source))
    }

    @Fact
    func NestedGenericTypeArg_StaticCall_Executes() {
        // `Box[List[int32]].Make(100)` — nested-generic single type argument.
        let source = `package P
import System.Collections.Generic
struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
public var result = Box[List[int32]].Make(100)`
        Assert.Equal(101, RunAndGetIntResult(source))
    }

    @Fact
    func SimpleTypeArg_StaticCall_StillExecutes() {
        // Control: a simple single type argument `Box[int32].Make(7)` keeps
        // working (this resolves through the index-then-member binder path).
        let source = `package P
struct Box[T] { shared { func Make(x int32) int32 { return x + 1 } } }
public var result = Box[int32].Make(7)`
        Assert.Equal(8, RunAndGetIntResult(source))
    }

    @Fact
    func MultiTypeArg_StaticCall_Executes() {
        // Control: a multi-type-argument list followed by `.` commits to a
        // generic call site (`Pair[int32, string].Make(21)`).
        let source = `package P
struct Pair[T, U] { shared { func Make(x int32) int32 { return x * 2 } } }
public var result = Pair[int32, string].Make(21)`
        Assert.Equal(42, RunAndGetIntResult(source))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssembly(source)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1323_emit_").FullName
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
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
            return EmittedFixture.Load(outPath)
        }
    }
}
