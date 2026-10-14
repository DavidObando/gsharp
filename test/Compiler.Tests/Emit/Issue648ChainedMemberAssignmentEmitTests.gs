// <copyright file="Issue648ChainedMemberAssignmentEmitTests.cs" company="GSharp">
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

/// Issue #648: `a.B.C = value` previously failed to parse with
/// `GS0005: Unexpected token <EqualsToken>`. The parser only
/// recognized the single-level `id.field = value` pattern; any deeper
/// chained member-access assignment had no production to match. The fix
/// detects a trailing member access after `ParseBinaryExpression()`
/// returns, lifts the terminal name out of the accessor tree, and wraps it
/// in a new `MemberFieldAssignmentExpressionSyntax`. The binder routes
/// the receiver through normal expression binding and dispatches the
/// assignment to the existing `BoundFieldAssignmentExpression` (with
/// expression receiver) or `BoundPropertyAssignmentExpression` as
/// appropriate.
open class Issue648ChainedMemberAssignmentEmitTests {
    @Fact
    func ChainedFieldAssignment_TwoLevels_WritesAndReadsBack() {
        // a.B.C = value where B is a class field and C is a field.
        let source = `package P
import System

class Inner {
    var Value int32
    init() {}
}

class Outer {
    var Inner Inner
    init() { Inner = Inner() }
}

var o = Outer()
o.Inner.Value = 42
public var result = o.Inner.Value`
        Assert.Equal(42, RunAndGetIntResult(source))
    }

    @Fact
    func ChainedPropertyAssignment_TwoLevels_WritesAndReadsBack() {
        // a.B.C = value where B is a field and C is a property.
        let source = `package P
import System

class Inner {
    prop Value int32
    init() {}
}

class Outer {
    var Inner Inner
    init() { Inner = Inner() }
}

var o = Outer()
o.Inner.Value = 99
public var result = o.Inner.Value`
        Assert.Equal(99, RunAndGetIntResult(source))
    }

    @Fact
    func ChainedFieldAssignment_ThreeLevels_WritesAndReadsBack() {
        // a.B.C.D = value — 3-deep chain.
        let source = `package P
import System

class Leaf {
    var Val int32
    init() {}
}

class Mid {
    var Leaf Leaf
    init() { Leaf = Leaf() }
}

class Root {
    var Mid Mid
    init() { Mid = Mid() }
}

var r = Root()
r.Mid.Leaf.Val = 77
public var result = r.Mid.Leaf.Val`
        Assert.Equal(77, RunAndGetIntResult(source))
    }

    @Fact
    func ChainedAssignment_ThroughMethodCall_WritesAndReadsBack() {
        // a.GetInner().Value = 42 — method call in the chain.
        let source = `package P
import System

class Inner {
    var Value int32
    init() {}
}

class Outer {
    var _inner Inner
    init() { _inner = Inner() }
    func GetInner() Inner { return _inner }
}

var o = Outer()
o.GetInner().Value = 55
public var result = o.GetInner().Value`
        Assert.Equal(55, RunAndGetIntResult(source))
    }

    @Fact
    func ChainedCompoundAssignment_PlusEquals_WritesAndReadsBack() {
        // a.B.C += value — compound assignment on chained member.
        let source = `package P
import System

class Inner {
    var Value int32
    init() {}
}

class Outer {
    var Inner Inner
    init() { Inner = Inner() }
}

var o = Outer()
o.Inner.Value = 10
o.Inner.Value += 5
public var result = o.Inner.Value`
        Assert.Equal(15, RunAndGetIntResult(source))
    }

    @Fact
    func ChainedCompoundAssignment_MinusEquals_WritesAndReadsBack() {
        // a.B.C -= value — compound assignment on chained member.
        let source = `package P
import System

class Inner {
    var Value int32
    init() {}
}

class Outer {
    var Inner Inner
    init() { Inner = Inner() }
}

var o = Outer()
o.Inner.Value = 20
o.Inner.Value -= 3
public var result = o.Inner.Value`
        Assert.Equal(17, RunAndGetIntResult(source))
    }

    @Fact
    func InvalidAssignmentLHS_StillReportsDiagnostic() {
        // `(a + b).C = 42` is not a valid assignment LHS — should report error.
        let source = `package P
import System

class Box {
    var Value int32
    init() {}
}

func getBox() Box { return Box() }

func main() {
    var a = 1
    var b = 2
    (a + b).Value = 42
}`
        let (exitCode, stderr) = CompileAndGetError(source)
        Assert.NotEqual(0, exitCode)
        // Parenthesized arithmetic is not an AccessorExpressionSyntax so
        // TryLiftTrailingMemberAccess won't fire; the assignment is invalid.
        Assert.Contains("error", stderr, StringComparison.OrdinalIgnoreCase)
    }

    @Fact
    func ChainedPropertyAssignment_ThroughProperty_WritesAndReadsBack() {
        // a.B.C = value where B is a property returning a ref type, and C is a property.
        let source = `package P
import System

class Inner {
    prop Val int32
    init() {}
}

class Outer {
    var _inner Inner
    prop Inner Inner {
        get { return _inner }
        set { _inner = value }
    }
    init() { _inner = Inner() }
}

var o = Outer()
o.Inner.Val = 123
public var result = o.Inner.Val`
        Assert.Equal(123, RunAndGetIntResult(source))
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

        private func CompileAndGetError(source string)(exitCode int32, stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_648_emit_").FullName
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
            return (compileExit, compileOut.ToString() + compileErr.ToString())
        }

        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_648_emit_").FullName
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
