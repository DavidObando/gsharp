// <copyright file="PropertyAssignmentSpillEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Regression tests for issue #418 (P1-2): a property-assignment expression
/// must evaluate its RHS exactly once and must not invoke the getter
/// afterwards to recover the expression result. The pre-fix emitter pushed
/// the receiver, called the setter, then re-pushed the receiver and called
/// the getter — doubling any side effect inside a custom getter and re-loading
/// the receiver. The fix spills the assigned value into a temp and yields it
/// directly via `dup; stloc; setter; ldloc`.
open class PropertyAssignmentSpillEmitTests {
    @Fact
    func UserComputedProperty_Assignment_DoesNotInvokeGetter() {
        // The assignment `b.Value = 7` is used as a statement. The setter
        // must run once; the getter must NOT run at all (the expression
        // result is the assigned value, not a read-back through the getter).
        const Source = `package P1_2_NoGetter
import System

var getterCalls = 0
var setterCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get {
            getterCalls = getterCalls + 1
            return this.raw
        }
        set(v) {
            setterCalls = setterCalls + 1
            this.raw = v
        }
    }
}

var b = Box{}
b.Value = 7
Console.WriteLine(getterCalls)
Console.WriteLine(setterCalls)
Console.WriteLine(b.raw)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-NoGetter"))
        Assert.Equal("0", lines[0])
        Assert.Equal("1", lines[1])
        Assert.Equal("7", lines[2])
    }

    @Fact
    func UserComputedProperty_AssignmentExpression_YieldsAssignedValue_WithoutGetter() {
        // The assignment is consumed by Console.WriteLine, so the expression
        // result is observable. It must equal the assigned value AND the
        // getter must not run.
        const Source = `package P1_2_ExprValue
import System

var getterCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get {
            getterCalls = getterCalls + 1
            return this.raw
        }
        set(v) { this.raw = v }
    }
}

var b = Box{}
Console.WriteLine(b.Value = 42)
Console.WriteLine(getterCalls)
Console.WriteLine(b.raw)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-ExprValue"))
        Assert.Equal("42", lines[0])
        Assert.Equal("0", lines[1])
        Assert.Equal("42", lines[2])
    }

    @Fact
    func UserComputedProperty_AssignmentExpression_RhsEvaluatedOnce() {
        // The RHS value expression must evaluate exactly once even though
        // the assignment is consumed as an expression.
        const Source = `package P1_2_RhsOnce
import System

var rhsCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get { return this.raw }
        set(v) { this.raw = v }
    }
}

var b = Box{}

func nextValue() int32 {
    rhsCalls = rhsCalls + 1
    return 99
}

Console.WriteLine(b.Value = nextValue())
Console.WriteLine(rhsCalls)
Console.WriteLine(b.raw)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-RhsOnce"))
        Assert.Equal("99", lines[0])
        Assert.Equal("1", lines[1])
        Assert.Equal("99", lines[2])
    }

    @Fact
    func ClrInstanceProperty_AssignmentExpression_YieldsAssignedValue() {
        // CLR property setter (StringBuilder.Capacity) via the
        // EmitClrPropertyAssignment path. Verifies the expression result is
        // the assigned value, not a read-back through the getter.
        const Source = `package P1_2_ClrExpr
import System
import System.Text

var sb = StringBuilder()
Console.WriteLine(sb.Capacity = 128)
Console.WriteLine(sb.Capacity >= 128)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-ClrExpr"))
        Assert.Equal("128", lines[0])
        Assert.Equal("True", lines[1])
    }

    @Fact
    func ClrInstanceProperty_AssignmentStatement_StoresValue() {
        // Plain statement-form CLR property assignment must still work after
        // the dup/stloc/ldloc rewrite.
        const Source = `package P1_2_ClrStmt
import System
import System.Text

var sb = StringBuilder()
sb.Capacity = 256
Console.WriteLine(sb.Capacity >= 256)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-ClrStmt"))
        Assert.Equal("True", lines[0])
    }

    @Fact
    func UserComputedProperty_NestedAssignments_EachYieldAssignedValue() {
        // Two distinct property-assignment expressions in the same body each
        // need their own value-spill slot. Verifies the pre-allocator handles
        // multiple assignments correctly.
        const Source = `package P1_2_NestedAssn
import System

var getterCalls = 0

class Box {
    prop raw int32
    prop Value int32 {
        get {
            getterCalls = getterCalls + 1
            return this.raw
        }
        set(v) { this.raw = v }
    }
}

var a = Box{}
var b = Box{}
Console.WriteLine(a.Value = 10)
Console.WriteLine(b.Value = 20)
Console.WriteLine(getterCalls)
Console.WriteLine(a.raw)
Console.WriteLine(b.raw)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-NestedAssn"))
        Assert.Equal("10", lines[0])
        Assert.Equal("20", lines[1])
        Assert.Equal("0", lines[2])
        Assert.Equal("10", lines[3])
        Assert.Equal("20", lines[4])
    }

    @Fact
    func UserIndexerAssignmentExpression_YieldsAssignedValue_WithSetOnlyIndexer() {
        const Source = `package P1_2_IndexExpr
import System

var receiverCalls = 0
var indexCalls = 0
var valueCalls = 0

class Box {
    var raw []int32 = [1]int32
    prop this[index int32] int32 {
        set(v) { this.raw[index] = v }
    }
}

var box = Box{}

func receiver() Box {
    receiverCalls++
    return box
}

func nextIndex() int32 {
    indexCalls++
    return 0
}

func nextValue() int32 {
    valueCalls++
    return 42
}

Console.WriteLine(receiver()[nextIndex()] = nextValue())
Console.WriteLine(receiverCalls)
Console.WriteLine(indexCalls)
Console.WriteLine(valueCalls)
Console.WriteLine(box.raw[0])
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "P1_2-IndexExpr"))
        Assert.Equal("42", lines[0])
        Assert.Equal("1", lines[1])
        Assert.Equal("1", lines[2])
        Assert.Equal("1", lines[3])
        Assert.Equal("42", lines[4])
    }

    shared {
        private func SplitLines(output string)[]string -> output
            .ReplaceLineEndings(Environment.NewLine)
            .TrimEnd(Environment.NewLine.ToCharArray())
            .Split(Environment.NewLine)

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
