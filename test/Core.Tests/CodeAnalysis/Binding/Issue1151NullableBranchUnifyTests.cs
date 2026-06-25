// <copyright file="Issue1151NullableBranchUnifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1151: an <c>if</c>/<c>switch</c>-expression whose branches are a
/// value type <c>T</c> and <c>nil</c> must unify to <c>T?</c> — both when the
/// result type is inferred and when it is explicitly target-typed to <c>T?</c>.
/// The value arm is lifted to <c>T?</c> and the <c>nil</c> arm becomes the null
/// <c>T?</c>, mirroring C#'s target-typed conditional. Reference-type and
/// already-nullable arms are left unchanged (never double-wrapped).
/// </summary>
public class Issue1151NullableBranchUnifyTests
{
    [Fact]
    public void IfExpression_ValueTypeAndNil_Inferred_UnifiesToNullable()
    {
        var scope = BindGlobalScope(@"
let x = if true { 5 } else { nil }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType);
    }

    [Fact]
    public void IfExpression_ValueTypeAndNil_TargetTyped_BindsCleanly()
    {
        var scope = BindGlobalScope(@"
let x int32? = if true { 5 } else { nil }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType);
    }

    [Fact]
    public void SwitchExpression_ValueTypeAndNil_Inferred_UnifiesToNullable()
    {
        var scope = BindGlobalScope(@"
let x = switch true { case true: 5 default: nil }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType);
    }

    [Fact]
    public void SwitchExpression_ValueTypeAndNil_TargetTyped_BindsCleanly()
    {
        var scope = BindGlobalScope(@"
let x int32? = switch true { case true: 5 default: nil }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType);
    }

    [Fact]
    public void IssueRepro_FAndG_BindWithNoDiagnostics()
    {
        var diagnostics = Bind(@"
package p
class C {
    func F(present bool) int32? {
        let x = if present { 5 } else { nil }
        return x
    }
    func G(present bool) int32? {
        let x int32? = if present { 5 } else { nil }
        return x
    }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IfExpression_NullableReferenceAndNil_NotDoubleWrapped()
    {
        // Regression guard: a `string?` arm unified with `nil` stays `string?`
        // (NullableTypeSymbol.Get is idempotent) — it must NOT become
        // `string??`. Reference types are left untouched by the value-type lift.
        var scope = BindGlobalScope(@"
let s string? = ""hi""
let x = if true { s } else { nil }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType);
        Assert.IsNotType<NullableTypeSymbol>(nullable.UnderlyingType);
    }

    [Fact]
    public void IfExpression_Mpeg4StyleUInt32AndNil_UnifiesToNullable()
    {
        // The MPEG-4 optional-field pattern from the issue: a uint32 value arm
        // and a nil arm infer uint32?.
        var scope = BindGlobalScope(@"
let d = if true { 7u } else { nil }
");

        Assert.Empty(scope.Diagnostics);
        var d = scope.Variables.Single(v => v.Name == "d").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(d);
        Assert.Equal(TypeSymbol.UInt32, nullable.UnderlyingType);
    }

    [Fact]
    public void SwitchExpression_GenuineTypeMismatch_StillDiagnoses_GS0179()
    {
        // The fix must NOT suppress the pre-existing arm-mismatch diagnostic
        // for genuinely incompatible arms.
        var diagnostics = Bind(@"
let x = switch true { case true: 5 default: ""x"" }
");

        Assert.Contains(diagnostics, d => d.Id == "GS0179");
    }

    [Fact]
    public void IfExpression_GenuineTypeMismatch_StillDiagnoses_GS0263()
    {
        // Two incompatible value/reference arms (no nil) still have no common
        // type and report GS0263.
        var diagnostics = Bind(@"
let x = if true { 5 } else { ""x"" }
");

        Assert.Contains(diagnostics, d => d.Id == "GS0263");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }

    private static BoundGlobalScope BindGlobalScope(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
