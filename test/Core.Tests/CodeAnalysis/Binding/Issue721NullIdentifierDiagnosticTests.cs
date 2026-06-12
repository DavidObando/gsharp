// <copyright file="Issue721NullIdentifierDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #721 / ADR-0081 — when the user writes the C# spelling
/// <c>null</c> in a value-expression position and no symbol named
/// <c>null</c> exists in scope, the binder emits the friendly
/// GS0273 "did you mean 'nil'?" diagnostic and recovers by
/// synthesising a <c>nil</c> literal so target-type contexts
/// continue to typecheck.
/// </summary>
public class Issue721NullIdentifierDiagnosticTests
{
    [Fact]
    public void Let_NullableString_AssignedNull_ReportsGS0273()
    {
        var diags = Bind("""
            let x string? = null
            """);

        var diag = Assert.Single(diags.Where(d => d.Id == "GS0273"));
        Assert.Contains("'null'", diag.Message);
        Assert.Contains("'nil'", diag.Message);
        Assert.Contains("Did you mean", diag.Message);

        // The diagnostic is anchored at the 'null' token.
        Assert.Equal("null", diag.Location.Text.ToString(diag.Location.Span));

        // No cascading "cannot convert" or "name not found" diagnostic
        // should fire — the recovery synthesises a nil literal that
        // typechecks cleanly against `string?`.
        Assert.DoesNotContain(diags, d => d.Id == "GS0125");
    }

    [Fact]
    public void Call_With_NullableParameter_AssignedNull_ReportsGS0273()
    {
        var diags = Bind("""
            func Foo(s string?) {
            }

            Foo(null)
            """);

        var diag = Assert.Single(diags.Where(d => d.Id == "GS0273"));
        Assert.Contains("'nil'", diag.Message);
        Assert.Equal("null", diag.Location.Text.ToString(diag.Location.Span));

        // Recovery converts nil → string? cleanly: no other diagnostic.
        Assert.DoesNotContain(diags, d => d.Id == "GS0125");
        Assert.Empty(diags.Where(d => d.IsError && d.Id != "GS0273"));
    }

    [Fact]
    public void Equality_Against_Null_ReportsGS0273()
    {
        var diags = Bind("""
            let x string? = nil
            let same = x == null
            """);

        Assert.Contains(diags, d => d.Id == "GS0273");

        // Equality `x == nil` is well-formed for `string?` once the
        // recovery treats `null` as `nil`. The same comparison must
        // not produce a residual operator-mismatch diagnostic.
        Assert.DoesNotContain(diags, d => d.IsError && d.Id != "GS0273");
    }

    [Fact]
    public void Existing_Local_Named_Null_Resolves_Without_Diagnostic()
    {
        // A locally-declared `let null = "hi"` shadows the would-be
        // diagnostic. Subsequent uses of `null` resolve to the local
        // and GS0273 must not fire.
        var diags = Bind("""
            let null = "hi"
            let s = null
            """);

        Assert.Empty(diags.Where(d => d.IsError));
        Assert.DoesNotContain(diags, d => d.Id == "GS0273");
    }

    [Fact]
    public void Existing_Function_Named_Null_Resolves_Without_Diagnostic()
    {
        // A free function named `null` is legal — `null` is not a
        // keyword. Calling it must not produce GS0273.
        var diags = Bind("""
            func null() int32 {
                return 42
            }

            let v = null()
            """);

        Assert.Empty(diags.Where(d => d.IsError));
        Assert.DoesNotContain(diags, d => d.Id == "GS0273");
    }

    [Fact]
    public void Let_Without_Target_Type_Reports_GS0273_With_Recovery()
    {
        // No target type is available for `let x = null`; the binder
        // still reports GS0273 (the user clearly intended nil), and
        // recovers by synthesising a nil literal so downstream
        // diagnostics about nil-typed bindings are not stacked
        // on top of a cascading "name not found" diagnostic.
        var diags = Bind("""
            let x = null
            """);

        Assert.Contains(diags, d => d.Id == "GS0273");

        // The legacy GS0125 path is no longer reached for `null`.
        Assert.DoesNotContain(diags, d => d.Id == "GS0125");
    }

    [Fact]
    public void Null_Inside_Lambda_Body_Reports_GS0273_And_Typechecks()
    {
        // Inside a lambda body, the same BindNameExpression path
        // applies — GS0273 fires for the inner `null` and the
        // synthesised nil flows into the local `string?` target
        // slot, which typechecks without cascading errors.
        var diags = Bind("""
            let f = () -> {
                let v string? = null
                return v
            }
            let _ = f()
            """);

        Assert.Contains(diags, d => d.Id == "GS0273");
        Assert.DoesNotContain(diags, d => d.IsError && d.Id != "GS0273");
    }

    [Fact]
    public void NullableInt_AssignedNull_ReportsGS0273()
    {
        // Nullable value-type target (`int32?` is a CLR Nullable<int>).
        var diags = Bind("""
            let n int32? = null
            """);

        var diag = Assert.Single(diags.Where(d => d.Id == "GS0273"));
        Assert.Equal("null", diag.Location.Text.ToString(diag.Location.Span));
        Assert.DoesNotContain(diags, d => d.Id == "GS0125");
    }

    [Fact]
    public void Existing_Nil_Program_Still_Compiles_And_Runs()
    {
        // Sanity guard: the changes for #721 must not regress the
        // canonical `nil` spelling.
        var result = Evaluate("""
            let x string? = nil
            if x == nil { 1 } else { 0 }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
