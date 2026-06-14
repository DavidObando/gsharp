// <copyright file="Issue818AnonymousFunctionTypeVariadicTests.cs" company="GSharp">
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
/// Issue #818 — binder / diagnostic / identity tests for variadic
/// parameters in anonymous function-type clauses
/// (<c>(T1, ...T2) -&gt; R</c>). ADR-0102 follow-up closing the v1
/// carve-out from ADR-0102 §6.
/// </summary>
public class Issue818AnonymousFunctionTypeVariadicTests
{
    [Fact]
    public void Issue818_Repro_VariadicAnonymousFunctionType_Binds()
    {
        // The exact repro from issue #818 — must bind and produce 4 + 1 = 5.
        var result = Evaluate(@"
let f (int32, ...string) -> int32 = (a, args) -> len(args) + a
f(1, ""a"", ""b"", ""c"", ""d"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void Issue818_PassThroughSlice_NoPack()
    {
        var result = Evaluate(@"
let f (int32, ...string) -> int32 = (a, args) -> len(args) + a
f(10, []string{""a"", ""b""})
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void Issue818_VariadicAnonymousType_EmptyTrailingArgs()
    {
        var result = Evaluate(@"
let f (int32, ...string) -> int32 = (a, args) -> len(args) + a
f(7)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Issue818_FunctionTypeIdentity_VariadicFlagMatters()
    {
        // Two anonymous function-type symbols with the same parameter
        // shape but different variadic flags must NOT be identical.
        var variadic = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32);

        var nonVariadic = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, false),
            TypeSymbol.Int32);

        Assert.NotSame(variadic, nonVariadic);
        Assert.True(variadic.HasVariadic);
        Assert.False(nonVariadic.HasVariadic);
    }

    [Fact]
    public void Issue818_FunctionTypeIdentity_SameShape_SameVariadic_AreIdentical()
    {
        var a = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32);

        var b = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32);

        Assert.Same(a, b);
    }

    [Fact]
    public void Issue818_FunctionTypeIdentity_NoVariadicArray_EqualsAllFalse()
    {
        // Backwards-compat overload: `Get(paramTypes, returnType)` is the
        // legacy pre-#818 entry point and must produce the same instance as
        // the new overload with an all-false flag array (or an empty/default
        // flag array indicating "no variadic anywhere").
        var legacy = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            TypeSymbol.Int32);

        var explicitNonVariadic = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, false),
            TypeSymbol.Int32);

        Assert.Same(legacy, explicitNonVariadic);
    }

    [Fact]
    public void Issue818_DisplayName_ShowsEllipsisOnVariadicSlot()
    {
        var t = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32);

        Assert.Contains("...", t.Name);
    }

    [Fact]
    public void Issue818_NamedDelegateInvoke_FromAnonymousVariadicCall()
    {
        // A named variadic delegate type is callable through a variable
        // typed as the matching anonymous variadic function-type. This
        // exercises the call-site pack on the variable path.
        var result = Evaluate(@"
let f (int32, ...string) -> int32 = (a, args) -> a + len(args)
f(3, ""x"", ""y"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void Issue818_Misuse_VariadicNotLast_ReportsGS0145()
    {
        var diags = Bind(@"
package P
let f (...string, int32) -> int32 = (xs, n) -> n
");
        Assert.Contains(diags, d => d.Id == "GS0145");
    }

    [Fact]
    public void Issue818_Misuse_MultiVariadic_ReportsGS0364()
    {
        var diags = Bind(@"
package P
let f (...int32, ...string) -> int32 = (xs, ys) -> 0
");
        Assert.Contains(diags, d => d.Id == "GS0364");
    }

    [Fact]
    public void Issue818_AnonymousVariadic_AcceptsRegularLambda_OfTheRightShape()
    {
        // A regular-form (non-variadic) lambda whose parameter shape
        // matches the variadic target's stored shape is assignable into
        // the variadic anonymous function-type slot. The implicit
        // conversion bridges the variadic-flag-only difference.
        var result = Evaluate(@"
let count (int32, ...string) -> int32 = (a, args) -> a + len(args)
count(2, ""x"", ""y"", ""z"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From("import Gsharp.Extensions.Go\n" + source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
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
}
