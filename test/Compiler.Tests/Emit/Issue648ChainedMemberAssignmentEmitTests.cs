// <copyright file="Issue648ChainedMemberAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #648: <c>a.B.C = value</c> previously failed to parse with
/// <c>GS0005: Unexpected token &lt;EqualsToken&gt;</c>. The parser only
/// recognized the single-level <c>id.field = value</c> pattern; any deeper
/// chained member-access assignment had no production to match. The fix
/// detects a trailing member access after <c>ParseBinaryExpression()</c>
/// returns, lifts the terminal name out of the accessor tree, and wraps it
/// in a new <c>MemberFieldAssignmentExpressionSyntax</c>. The binder routes
/// the receiver through normal expression binding and dispatches the
/// assignment to the existing <c>BoundFieldAssignmentExpression</c> (with
/// expression receiver) or <c>BoundPropertyAssignmentExpression</c> as
/// appropriate.
/// </summary>
public class Issue648ChainedMemberAssignmentEmitTests
{
    [Fact]
    public void ChainedFieldAssignment_TwoLevels_WritesAndReadsBack()
    {
        // a.B.C = value where B is a class field and C is a field.
        var source = """
            package P
            import System

            type Inner class {
                Value int32
                init() {}
            }

            type Outer class {
                Inner Inner
                init() { Inner = Inner() }
            }

            var o = Outer()
            o.Inner.Value = 42
            public var result = o.Inner.Value
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedPropertyAssignment_TwoLevels_WritesAndReadsBack()
    {
        // a.B.C = value where B is a field and C is a property.
        var source = """
            package P
            import System

            type Inner class {
                prop Value int32
                init() {}
            }

            type Outer class {
                Inner Inner
                init() { Inner = Inner() }
            }

            var o = Outer()
            o.Inner.Value = 99
            public var result = o.Inner.Value
            """;

        Assert.Equal(99, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedFieldAssignment_ThreeLevels_WritesAndReadsBack()
    {
        // a.B.C.D = value — 3-deep chain.
        var source = """
            package P
            import System

            type Leaf class {
                Val int32
                init() {}
            }

            type Mid class {
                Leaf Leaf
                init() { Leaf = Leaf() }
            }

            type Root class {
                Mid Mid
                init() { Mid = Mid() }
            }

            var r = Root()
            r.Mid.Leaf.Val = 77
            public var result = r.Mid.Leaf.Val
            """;

        Assert.Equal(77, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedAssignment_ThroughMethodCall_WritesAndReadsBack()
    {
        // a.GetInner().Value = 42 — method call in the chain.
        var source = """
            package P
            import System

            type Inner class {
                Value int32
                init() {}
            }

            type Outer class {
                _inner Inner
                init() { _inner = Inner() }
                func GetInner() Inner { return _inner }
            }

            var o = Outer()
            o.GetInner().Value = 55
            public var result = o.GetInner().Value
            """;

        Assert.Equal(55, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedCompoundAssignment_PlusEquals_WritesAndReadsBack()
    {
        // a.B.C += value — compound assignment on chained member.
        var source = """
            package P
            import System

            type Inner class {
                Value int32
                init() {}
            }

            type Outer class {
                Inner Inner
                init() { Inner = Inner() }
            }

            var o = Outer()
            o.Inner.Value = 10
            o.Inner.Value += 5
            public var result = o.Inner.Value
            """;

        Assert.Equal(15, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedCompoundAssignment_MinusEquals_WritesAndReadsBack()
    {
        // a.B.C -= value — compound assignment on chained member.
        var source = """
            package P
            import System

            type Inner class {
                Value int32
                init() {}
            }

            type Outer class {
                Inner Inner
                init() { Inner = Inner() }
            }

            var o = Outer()
            o.Inner.Value = 20
            o.Inner.Value -= 3
            public var result = o.Inner.Value
            """;

        Assert.Equal(17, RunAndGetIntResult(source));
    }

    [Fact]
    public void InvalidAssignmentLHS_StillReportsDiagnostic()
    {
        // `(a + b).C = 42` is not a valid assignment LHS — should report error.
        var source = """
            package P
            import System

            type Box class {
                Value int32
                init() {}
            }

            func getBox() Box { return Box() }

            func main() {
                var a = 1
                var b = 2
                (a + b).Value = 42
            }
            """;

        var (exitCode, stderr) = CompileAndGetError(source);
        Assert.NotEqual(0, exitCode);
        // Parenthesized arithmetic is not an AccessorExpressionSyntax so
        // TryLiftTrailingMemberAccess won't fire; the assignment is invalid.
        Assert.Contains("error", stderr, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ChainedPropertyAssignment_ThroughProperty_WritesAndReadsBack()
    {
        // a.B.C = value where B is a property returning a ref type, and C is a property.
        var source = """
            package P
            import System

            type Inner class {
                prop Val int32
                init() {}
            }

            type Outer class {
                _inner Inner
                prop Inner Inner {
                    get { return _inner }
                    set { _inner = value }
                }
                init() { _inner = Inner() }
            }

            var o = Outer()
            o.Inner.Val = 123
            public var result = o.Inner.Val
            """;

        Assert.Equal(123, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        return (int)resultField!.GetValue(null)!;
    }

    private static (int exitCode, string stderr) CompileAndGetError(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_648_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return (compileExit, compileOut.ToString() + compileErr.ToString());
    }

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_648_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
