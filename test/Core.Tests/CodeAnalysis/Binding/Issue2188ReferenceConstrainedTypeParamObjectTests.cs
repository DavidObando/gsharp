// <copyright file="Issue2188ReferenceConstrainedTypeParamObjectTests.cs" company="GSharp">
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
/// Issue #2188: a reference-constrained type parameter (<c>[T class …]</c> or a
/// class-base constraint such as <c>[T Base]</c>) is provably a reference type,
/// so it must participate in reference conversions and reference equality in
/// both its nullable (<c>T?</c>) and non-nullable (<c>T</c>) forms, exactly like
/// any other reference type:
/// <list type="bullet">
/// <item><c>T -&gt; object</c> and <c>T? -&gt; object?</c> are implicit (GS0155
/// previously rejected the nullable form).</item>
/// <item><c>object?/object == T?/T</c> and <c>!=</c> resolve to reference
/// equality in either operand order (GS0129 previously rejected them).</item>
/// </list>
/// The fix generalises rather than special-casing <c>object</c>: the same rule
/// covers base-class and interface targets in the constraint set. Unconstrained
/// and <c>struct</c>-constrained parameters (whose <c>T?</c> erases to
/// <c>Nullable&lt;T&gt;</c>, a value type) are intentionally excluded and keep
/// their value-type rules — the negative cases below prove they still error.
/// </summary>
public class Issue2188ReferenceConstrainedTypeParamObjectTests
{
    [Fact]
    public void ClassConstrainedNullableTypeParam_ToNullableObject_Assignment_Compiles()
    {
        var source = @"
package p
func Sink[T class init()]() {
    var v T? = nil
    var box object? = v
    box = v
}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ClassConstrainedNullableTypeParam_ToNullableObject_Return_Compiles()
    {
        var source = @"
package p
func Sink[T class](x T?) object? -> x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ClassConstrainedNonNullableTypeParam_ToObject_StillCompiles()
    {
        // Guard: the pre-existing `T -> object` reference conversion (#1540)
        // must keep working alongside the new nullable form.
        var source = @"
package p
func Sink[T class](x T) object -> x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableObject_EqualsNullableClassTypeParam_Compiles()
    {
        var source = @"
package p
func Cmp[T class](x T?, o object?) bool -> o == x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableClassTypeParam_NotEqualsNullableObject_Compiles()
    {
        // Reverse operand order must resolve identically.
        var source = @"
package p
func Cmp[T class](x T?, o object?) bool -> x != o
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullableObject_EqualsNonNullableClassTypeParam_Compiles()
    {
        var source = @"
package p
func Cmp[T class](x T, o object) bool -> o == x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void BaseClassConstrainedNullableTypeParam_ToNullableObject_Compiles()
    {
        // Generalisation: a class-base constraint (`[T Animal]`) is also a
        // provable reference type.
        var source = @"
package p
class Animal { init() {} }
func Sink[T Animal](x T?) object? -> x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void BaseClassConstrainedNullableTypeParam_ToNullableBase_Compiles()
    {
        // Not special-cased to `object`: the reference conversion also reaches
        // the base-class constraint target.
        var source = @"
package p
class Animal { init() {} }
func Sink[T Animal](x T?) Animal? -> x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void BaseClassConstrained_NullableBaseEqualsNullableTypeParam_Compiles()
    {
        var source = @"
package p
class Animal { init() {} }
func Cmp[T Animal](x T?, a Animal?) bool -> a == x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void UnconstrainedNullableTypeParam_ToNullableObject_ReportsConversionError()
    {
        // Negative: an UNCONSTRAINED T's `T?` is `Nullable<T>` (a value type),
        // NOT a reference — it must NOT convert to `object?`.
        var source = @"
package p
func Sink[T](x T?) object? -> x
";
        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Contains(diagnostics, d => d.Id == "GS0155" || d.Message.Contains("Cannot convert"));
    }

    [Fact]
    public void UnconstrainedNullableTypeParam_EqualsNullableObject_ReportsOperatorError()
    {
        // Negative: reference equality must NOT be admitted for an
        // unconstrained (value-or-reference) `T?`.
        var source = @"
package p
func Cmp[T](x T?, o object?) bool -> o == x
";
        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Contains(diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void StructConstrainedNullableTypeParam_EqualsNullableObject_ReportsOperatorError()
    {
        // Negative: a `struct`-constrained `T?` is a genuine `Nullable<T>`
        // value type and must not be reference-compared to `object?`.
        var source = @"
package p
func Cmp[T struct](x T?, o object?) bool -> o == x
";
        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Contains(diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void ExactIssueRepro_Compiles()
    {
        var source = @"
package Repro
class C {
    shared {
        var box object?
        func Put[T class init()]() {
            var v T? = nil
            C.box = v
            if C.box != v {
                C.box = nil
            }
        }
    }
}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
