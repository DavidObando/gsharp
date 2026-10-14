// <copyright file="FieldAssignmentEmitTests.cs" company="GSharp">
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

/// Issue #420 (P3-4) regression tests. `EmitFieldAssignment` emits the
/// receiver twice — once for the `stfld`, once again after the store to
/// reload the field for the expression result. The reload only matches the
/// freshly-stored value as long as evaluating the value expression cannot
/// reassign the receiver variable. These tests pin down the normal-case
/// behavior (post-store reload returns the just-written value for struct and
/// class receivers) so any regression in the receiver-reload sequence is
/// caught immediately.
open class FieldAssignmentEmitTests {
    @Fact
    func StructFieldAssignment_ResultIs_AssignedValue() {
        // The assignment expression is used as the initializer for `result`,
        // so its value must equal the freshly-stored 42 — which is what the
        // post-store ldfld in EmitFieldAssignment guarantees.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
public var result = (p.X = 42)`
        Assert.Equal(42, RunAndGetIntResult(source))
    }

    @Fact
    func StructFieldAssignment_LeavesReceiverFieldUpdated() {
        // Verifies the stfld actually writes through the receiver address —
        // reading p.X after the assignment must yield the stored value.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
p.X = 99
public var result = p.X`
        Assert.Equal(99, RunAndGetIntResult(source))
    }

    @Fact
    func ClassFieldAssignment_ResultIs_AssignedValue() {
        // Class receiver path: receiver reference is loaded twice. The
        // post-store ldfld must observe the just-written value.
        let source = `package P
import System

class Box {
    var Value int32
}

var b = Box{Value: 1}
public var result = (b.Value = 7)`
        Assert.Equal(7, RunAndGetIntResult(source))
    }

    @Fact
    func ClassFieldAssignment_LeavesReceiverFieldUpdated() {
        let source = `package P
import System

class Box {
    var Value int32
}

var b = Box{Value: 1}
b.Value = 123
public var result = b.Value`
        Assert.Equal(123, RunAndGetIntResult(source))
    }

    @Fact
    func NestedStructFieldAssignment_ThroughClassField_LeavesFieldUpdated() {
        let source = `package P
import System

struct Item {
    var Id int32
}

class Holder {
    var Value Item
}

let holder = Holder()
holder.Value.Id = 7
public var result = holder.Value.Id`
        Assert.Equal(7, RunAndGetIntResult(source))
    }

    @Fact
    func NestedStructFieldCompoundAssignment_EvaluatesRootReceiverOnce() {
        let source = `package P
import System

struct Item {
    var Id int32
}

class Holder {
    var Value Item
}

public var calls = 0
public var lastHolder = Holder()

func GetHolder() Holder {
    calls += 1
    var holder = Holder()
    holder.Value.Id = 10
    lastHolder = holder
    return holder
}

GetHolder().Value.Id += 5
public var result = (lastHolder.Value.Id * 10) + calls`
        Assert.Equal(151, RunAndGetIntResult(source))
    }

    @Fact
    func MutableStaticStructFieldAssignments_UpdateStorage() {
        let source = `package P2818MutableStaticEmit
import System

struct Item {
    var Id int32
}

class Holder {
    shared {
        var Origin Item = Item{Id: 1}
    }
}

Holder.Origin.Id = 5
Holder.Origin.Id += 2
public var result = Holder.Origin.Id`
        Assert.Equal(7, RunAndGetIntResult(source))
    }

    @Fact
    func StaticReadonlyStructFieldAssignments_InDeclaringCctor_UpdateStorage() {
        let source = `package P2818ReadonlyStaticCctorEmit
import System

struct Item {
    var Id int32
}

class Holder {
    shared {
        let Origin Item = Item{Id: 1}
        init {
            Holder.Origin.Id = 5
            Holder.Origin.Id += 2
        }
    }
}

public var result = Holder.Origin.Id`
        Assert.Equal(7, RunAndGetIntResult(source))
    }

    @Fact
    func StructFieldAssignment_ValueExpressionReadsReceiver() {
        // Reading the receiver inside the value expression is fine and must
        // be supported — only *mutating* the receiver in the value side is
        // the unsafe shape the binder doesn't produce. This guards the
        // assertion in EmitFieldAssignment from being overly aggressive.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 10, Y: 0}
p.X = p.X + 5
public var result = p.X`
        Assert.Equal(15, RunAndGetIntResult(source))
    }

    @Fact
    func InheritedField_Read_ThroughDerivedReceiver() {
        // ADR-0112 A3: reading an inherited field through a derived receiver.
        // The emitted ldfld token must name the DECLARING (base) struct, so the
        // declaring-type path in TypeMemberModel.TryGetFieldIncludingInherited
        // is exercised. ilverify (in CompileToAssembly) pins token correctness.
        let source = `package P
import System

open class Base {
    var BaseVal int32 = 7
}

class Derived : Base {
    var DerivedVal int32 = 2
}

var d = Derived()
public var result = d.BaseVal`
        Assert.Equal(7, RunAndGetIntResult(source))
    }

    @Fact
    func InheritedField_Write_ThroughDerivedReceiver() {
        // ADR-0112 A3: writing an inherited field through a derived receiver.
        // The emitted stfld token must name the DECLARING (base) struct.
        let source = `package P
import System

open class Base {
    var BaseVal int32 = 7
}

class Derived : Base {
    var DerivedVal int32 = 2
}

var d = Derived()
d.BaseVal = 55
public var result = d.BaseVal`
        Assert.Equal(55, RunAndGetIntResult(source))
    }

    @Fact
    func InheritedField_CompoundAssignment_ThroughDerivedReceiver() {
        // ADR-0112 A3: compound (+=) assignment on an inherited field exercises
        // the chained-compound declaring-type path for both read and write.
        let source = `package P
import System

open class Base {
    var BaseVal int32 = 7
}

class Derived : Base {
    var DerivedVal int32 = 2
}

var d = Derived()
d.BaseVal += 3
public var result = d.BaseVal`
        Assert.Equal(10, RunAndGetIntResult(source))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssembly(source, target: "exe")
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

        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_field_assign_emit_").FullName
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
