// <copyright file="Issue2171NullableIsInterfaceNarrowingTests.cs" company="GSharp">
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
/// Issue #2171 (follow-up to #2165) — <c>is</c>-pattern smart-cast narrowing to
/// an INTERFACE must also take effect when the operand's static type is a
/// NULLABLE type parameter (<c>T?</c>) or a nullable interface (<c>IShape?</c>),
/// not only the non-nullable forms fixed by #2165. Stripping the nullable
/// wrapper before applying the type-parameter/interface rule makes <c>T?</c>
/// behave like <c>T</c> (and <c>IShape?</c> like <c>IShape</c>), so
/// <c>if x is IInit</c> narrows <c>x</c> to <c>IInit</c> and <c>x.Init()</c>
/// resolves.
/// </summary>
public class Issue2171NullableIsInterfaceNarrowingTests
{
    [Fact]
    public void If_IsInterface_OnNullableTypeParameterOperand_NarrowsToTestedInterface()
    {
        // Declared type is a NULLABLE unconstrained type parameter (`T?`).
        var result = Evaluate(@"
interface IInit {
    func Init() void;
}
func Run[T](x T?) void {
    if x is IInit {
        x.Init()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsInterface_OnNullableInterfaceOperand_NarrowsToTestedInterface()
    {
        // Declared type is a NULLABLE (unrelated) interface (`IShape?`).
        var result = Evaluate(@"
interface IInit {
    func Init() void;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape?) void {
    if x is IInit {
        x.Init()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void And_IsInterface_OnNullableTypeParameterOperand_NarrowsRightOperand()
    {
        // The short-circuit (`x is I && …`) classifier must agree with the
        // `if`-statement classifier for nullable type-parameter operands.
        var result = Evaluate(@"
interface IInit {
    func Init() int32;
}
func Run[T](x T?) bool {
    return x is IInit && x.Init() > 0
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void And_IsInterface_OnNullableInterfaceOperand_NarrowsRightOperand()
    {
        var result = Evaluate(@"
interface IInit {
    func Init() int32;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape?) bool {
    return x is IInit && x.Init() > 0
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsInterface_OnNonNullableTypeParameterOperand_StillNarrows()
    {
        // Control: the non-nullable type-parameter operand case fixed by #2165
        // must keep working.
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
    public void If_IsInterface_OnNullableObjectOperand_StillNarrows()
    {
        // Control: the pre-existing `object?` operand case must keep working.
        var result = Evaluate(@"
interface IInit {
    func Init() void;
}
func Run(x object?) void {
    if x is IInit {
        x.Init()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
