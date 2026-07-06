// <copyright file="Issue2165IsInterfaceNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2165 — <c>is</c>-pattern smart-cast narrowing to an INTERFACE must
/// also take effect when the operand's static type is a TYPE PARAMETER
/// (<c>T</c>) or ANOTHER INTERFACE, not only when it is <c>object</c> or a
/// concrete class. A value of interface/type-parameter type may dynamically
/// implement additional, statically-unrelated interfaces, so <c>if x is IInit</c>
/// narrows <c>x</c> to <c>IInit</c> (Kotlin-parity) and <c>x.Init()</c> resolves.
/// </summary>
public class Issue2165IsInterfaceNarrowingTests
{
    [Fact]
    public void If_IsInterface_OnInterfaceOperand_NarrowsToTestedInterface()
    {
        // Declared type is another (unrelated) interface. Narrowing to the
        // tested interface must make its member resolvable.
        var result = Evaluate(@"
interface IInit {
    func Init() void;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape) void {
    if x is IInit {
        x.Init()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsInterface_OnTypeParameterOperand_NarrowsToTestedInterface()
    {
        // Declared type is an unconstrained type parameter.
        var result = Evaluate(@"
interface IInit {
    func Init() void;
}
func Run[T](x T) void {
    if x is IInit {
        x.Init()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void And_IsInterface_OnInterfaceOperand_NarrowsRightOperand()
    {
        // The short-circuit (`x is I && …`) classifier must agree with the
        // `if`-statement classifier for interface operands.
        var result = Evaluate(@"
interface IInit {
    func Init() int32;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape) bool {
    return x is IInit && x.Init() > 0
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsInterface_OnObjectOperand_StillNarrows()
    {
        // Control (A): the pre-existing `object` operand case must keep working.
        var result = Evaluate(@"
interface IInit {
    func Init() void;
}
func Run(x object) void {
    if x is IInit {
        x.Init()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsConcreteClass_OnObjectOperand_StillNarrows()
    {
        // Control (B): the pre-existing concrete-class operand case must keep
        // working.
        var result = Evaluate(@"
class Circle {
    func Blah() void {}
}
func Run(x object) void {
    if x is Circle {
        x.Blah()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsBaseInterface_OnInterfaceOperand_KeepsDeclaredMembers()
    {
        // A widening to a base interface the declared type already satisfies
        // must NOT narrow — the declared interface's own members must remain
        // resolvable (no regression, no member hiding).
        var result = Evaluate(@"
interface IBase {
    func Base() void;
}
interface IShape : IBase {
    func Area() int32;
}
func Run(x IShape) int32 {
    if x is IBase {
        return x.Area()
    }
    return 0
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InterfaceOperand_TestedMemberUnavailableBeforeTest()
    {
        // Before the narrowing test, `x` is still `IShape` — `Init()` (an
        // IInit-only member) must NOT resolve.
        var result = Evaluate(@"
interface IInit {
    func Init() void;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape) void {
    x.Init()
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Init"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
