// <copyright file="Issue1614FieldAssignmentReceiverOnceEmitTests.cs" company="GSharp">
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

/// Issue #1614: `EmitFieldAssignment`'s expression-receiver arm (the
/// shape produced by `BoundFieldAssignmentExpression.WithExpressionReceiver`
/// for `getObj().Field = v` / chained member assignment) emitted the
/// receiver TWICE — once for the `stfld`, once more afterwards to
/// `ldfld` the field back out as the expression result. When the
/// receiver is a side-effecting call, that call ran twice, and the second
/// run could even hand back a different object than the one written to.
/// Compound assignment (`getObj().Field += v`) routed through the same
/// node with the receiver already evaluated once for the read side, so the
/// bug tripled the call count.
///
/// The fix spills the assigned value into a pre-planned temp local (mirrors
/// the property-assignment fix for issue #418 P1-2): `receiver; value;
/// dup; stloc tmp; stfld; ldloc tmp`. The receiver is evaluated exactly
/// once for the simple-assignment shape, and the redundant post-store
/// evaluation is eliminated from the compound-assignment shape too.
open class Issue1614FieldAssignmentReceiverOnceEmitTests {
    @Fact
    func CallReceiverFieldAssignment_EvaluatesReceiverExactlyOnce() {
        let source = `package P
import System

class Box {
    var Count int32
}

public var calls = 0
let shared = Box()

func GetBox() Box {
    calls = calls + 1
    return shared
}

public var assignResult = GetBox().Count = 5
public var finalCount = shared.Count
public var callCount = calls`
        let (assignResult, finalCount, callCount) = RunAndGetThreeIntResults(
            source,
            "assignResult",
            "finalCount",
            "callCount"
        )
        Assert.Equal(5, assignResult)
        Assert.Equal(5, finalCount)
        Assert.Equal(1, callCount)
    }

    @Fact
    func CallReceiverFieldCompoundAssignment_DoesNotTripleEvaluateReceiver() {
        let source = `package P
import System

class Box {
    var Count int32
}

public var calls = 0
let shared = Box()

func GetBox() Box {
    calls = calls + 1
    return shared
}

shared.Count = 10
GetBox().Count += 5
public var finalCount = shared.Count
public var callCount = calls`
        let (finalCount, callCount) = RunAndGetTwoIntResults(source, "finalCount", "callCount")
        // Issue #1688: the compound-assignment receiver is spilled to a
        // temp and evaluated exactly ONCE, then reused for both the read
        // (current field value) and the write. Pre-#1688 this was two
        // evaluations (read + write); pre-#1614 it was three (plus a
        // spurious reload for the discarded statement-position result).
        Assert.Equal(15, finalCount)
        Assert.Equal(1, callCount)
    }

    @Fact
    func CallReceiverFieldCompoundAssignment_WritesBackToTheSameObjectItRead() {
        // The receiver is a call that mutates shared state and returns a
        // fresh object each invocation; the compound write must land on the
        // SAME instance the compound read observed (recorded via a global
        // set inside GetBox), not a second freshly-constructed instance.
        let source = `package P1688A
import System

class Box {
    var Count int32
}

public var calls = 0
public var lastBox = Box()

func GetBox() Box {
    calls = calls + 1
    var b = Box()
    b.Count = 10
    lastBox = b
    return b
}

GetBox().Count += 5
public var finalCount = lastBox.Count
public var callCount = calls`
        let (finalCount, callCount) = RunAndGetTwoIntResults(source, "finalCount", "callCount")
        Assert.Equal(15, finalCount)
        Assert.Equal(1, callCount)
    }

    @Fact
    func CallReceiverPropertyCompoundAssignment_EvaluatesReceiverExactlyOnce() {
        let source = `package P1688B
import System

class Box {
    var backing int32
    prop Count int32 { get { return backing } set { backing = value } }
}

public var calls = 0
let shared = Box()

func GetBox() Box {
    calls = calls + 1
    return shared
}

shared.Count = 10
GetBox().Count += 5
public var finalCount = shared.Count
public var callCount = calls`
        let (finalCount, callCount) = RunAndGetTwoIntResults(source, "finalCount", "callCount")
        Assert.Equal(15, finalCount)
        Assert.Equal(1, callCount)
    }

    @Fact
    func LocalReceiverFieldCompoundAssignment_NeedsNoSpillAndStillWorks() {
        // Trivial (local-variable) receivers have no side effect to
        // preserve; the fix must not force a temp for them, and the
        // compound assignment must still produce the correct result.
        let source = `package P1688C
import System

class Box {
    var Count int32
}

let shared = Box()
shared.Count = 10
shared.Count += 5
public var finalCount = shared.Count`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let finalCountField FieldInfo? = program.GetField("finalCount", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal(15, int32(finalCountField!!.GetValue(nil)!!))
    }

    shared {
        private func RunAndGetTwoIntResults(source string, firstField string, secondField string)(
            First int32,
            Second int32
        ) {
            let assembly = CompileToAssembly(source)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let first FieldInfo? = program.GetField(firstField, BindingFlags.Public | BindingFlags.Static)
            let second FieldInfo? = program.GetField(secondField, BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return (int32(first!!.GetValue(nil)!!), int32(second!!.GetValue(nil)!!))
        }

        private func RunAndGetThreeIntResults(source string, firstField string, secondField string, thirdField string)(
            First int32,
            Second int32,
            Third int32
        ) {
            let assembly = CompileToAssembly(source)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let first FieldInfo? = program.GetField(firstField, BindingFlags.Public | BindingFlags.Static)
            let second FieldInfo? = program.GetField(secondField, BindingFlags.Public | BindingFlags.Static)
            let third FieldInfo? = program.GetField(thirdField, BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return (int32(first!!.GetValue(nil)!!), int32(second!!.GetValue(nil)!!), int32(third!!.GetValue(nil)!!))
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1614_emit_").FullName
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
