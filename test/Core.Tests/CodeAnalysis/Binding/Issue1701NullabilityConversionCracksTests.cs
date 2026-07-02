// <copyright file="Issue1701NullabilityConversionCracksTests.cs" company="GSharp">
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
/// Issue #1701: two residual cracks in the Kotlin-model null-safety
/// invariant ("a reference <c>T?</c> must never implicitly convert to
/// non-nullable <c>T</c>"), surfaced during the #1627 review.
///
/// Crack 2 — <c>Conversion.Classify</c>'s nullable-open-type-parameter arm
/// (issue #1455) let a nullable <c>T?</c>, where <c>T</c> is reference-like
/// (unconstrained or <c>class</c>-constrained), implicitly box to a
/// non-nullable <c>object</c> target — erasing a possibly-null value into a
/// non-null slot. The fix restricts that implicit arm to
/// <c>struct</c>-constrained <c>T</c> (a genuine <c>Nullable&lt;T&gt;</c>
/// boxing, which is legitimate: a null value boxes to an actual null
/// reference). These tests assert the non-nullable-target erasure now
/// reports a null-safety diagnostic while every legitimate sibling
/// conversion keeps compiling.
/// </summary>
public class Issue1701NullabilityConversionCracksTests
{
    [Fact]
    public void ClassConstrainedNullableTypeParam_ToObject_ReportsNullSafetyDiagnostic()
    {
        // A ref-like T? boxed to non-nullable `object` must NOT be implicit;
        // this is the #1701 crack-2 erasure.
        var source = @"
package p
func Issue1701ASink[T class](x T?) object -> x
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Id == "GS0154" || d.Id == "GS0155" || d.Message.Contains("Cannot convert"));
    }

    [Fact]
    public void UnconstrainedNullableTypeParam_ToObject_ReportsNullSafetyDiagnostic()
    {
        var source = @"
package p
func Issue1701BSink[T](x T?) object -> x
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Id == "GS0154" || d.Id == "GS0155" || d.Message.Contains("Cannot convert"));
    }

    [Fact]
    public void ConcreteNullableReference_ToNullableObject_StillCompiles()
    {
        // A concrete nullable reference (not a generic type parameter) to a
        // NULLABLE object target must remain implicit — only the
        // non-nullable object erasure is the #1701 crack.
        var source = @"
package p
class Issue1701CBox {}
func Issue1701CSink(x Issue1701CBox?) object? -> x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ClassConstrainedNullableTypeParam_BangEscape_ToObject_StillCompiles()
    {
        var source = @"
package p
func Issue1701DSink[T class](x T?) object -> x!!
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ClassConstrainedNonNullableTypeParam_ToObject_StillCompiles()
    {
        // Bare non-nullable T -> object (issue #1540) must be unaffected.
        var source = @"
package p
func Issue1701ESink[T class](x T) object -> x
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void StructConstrainedNullableTypeParam_ToObject_StillCompiles()
    {
        // Value-type Nullable<T> boxing to object is a different, legitimate
        // path and must remain implicit.
        var source = @"
package p
func Issue1701FSink[T struct](x T?) object -> x
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
