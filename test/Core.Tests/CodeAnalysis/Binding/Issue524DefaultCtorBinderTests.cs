// <copyright file="Issue524DefaultCtorBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #524 — focused binder coverage. A <c>type X class { ... }</c> whose
/// body declares fields (but no explicit <c>init(...)</c> and no primary
/// constructor) must surface a synthesized parameterless default constructor
/// at the call site: <c>X()</c> must bind cleanly, with no diagnostics, and
/// reject any non-zero argument count with a clean diagnostic against the
/// class name. The same applies to imported CLR value types — <c>T()</c>
/// must always bind for a <c>System.ValueType</c> subclass (other than
/// enum/primitive) because the CLR provides every <c>struct</c> with an
/// implicit zero-initialising default ctor (<c>initobj</c> in IL).
/// </summary>
public class Issue524DefaultCtorBinderTests
{
    [Fact]
    public void GSharpClass_NoInit_CallExpression_BindsCleanly()
    {
        var source = @"
type Holder class {
    var Value int32
}

var h = Holder()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GSharpClass_NoInit_WrongArgCount_ReportsWrongArgumentCount()
    {
        // The synthesised default ctor accepts zero arguments. A positional
        // argument should be reported against the class name — not as a
        // missing function or a failing conversion.
        var source = @"
type Holder class {
    var Value int32
}

var h = Holder(7)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Holder"));
        // Must NOT report 'Holder' as a missing function — that was the
        // pre-fix shape (GS0130). We expect the binder to route through the
        // constructor-call path and emit a wrong-argument-count diagnostic.
        Assert.DoesNotContain(
            result.Diagnostics,
            d => d.Message.Contains("Function 'Holder' doesn't exist"));
    }

    [Fact]
    public void GSharpClass_EmptyBody_DefaultConstructor_BindsCleanly()
    {
        var source = @"
type Empty class { }

var e = Empty()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GSharpClass_ExplicitInit_Unchanged()
    {
        // Regression guard: classes that DO declare an explicit init(...)
        // must continue to bind against that constructor's parameter list.
        var source = @"
type Point class {
    var X int32
    var Y int32

    init(x int32, y int32) {
        X = x
        Y = y
    }
}

var p = Point(3, 4)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GSharpClass_PrimaryCtor_Unchanged()
    {
        // Regression guard: primary-ctor classes must keep binding.
        var source = @"
type Box class(value int32) { }

var b = Box(42)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrStruct_NoExplicitCtor_BindsCleanly_HashCode()
    {
        // System.HashCode is a public BCL value type with no public
        // constructors at all. Per the CLR contract, every value type has
        // an implicit zero-initialising default ctor; the binder must
        // route `HashCode()` through that synthetic path.
        var source = @"
import System

var h = HashCode()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrStruct_WithExplicitCtor_DefaultStillBinds_TimeSpan()
    {
        // Regression guard: a CLR struct that declares an explicit ctor
        // must still also accept a zero-argument default construction, the
        // same way `new TimeSpan()` compiles in C#.
        var source = @"
import System

var zero = TimeSpan()
var oneHour = TimeSpan(1, 0, 0)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrClass_WithDefaultCtor_StillBinds_StringBuilder()
    {
        // The #524 fallback fires only for value types; reference-type
        // constructor resolution must be unchanged.
        var source = @"
import System.Text

var sb = StringBuilder()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrAbstractClass_DefaultCall_StillFails()
    {
        // Regression guard for the value-type gating: abstract reference
        // types must NOT be magically constructible — the value-type
        // fallback added in #524 is gated on `IsValueType` precisely to
        // avoid accidentally enabling `new AbstractClass()`.
        var source = @"
import System.IO

var s = Stream()
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
