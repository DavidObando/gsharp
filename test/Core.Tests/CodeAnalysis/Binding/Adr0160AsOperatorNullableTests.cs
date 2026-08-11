// <copyright file="Adr0160AsOperatorNullableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0160 / issue #3349: <c>as</c> is a testing conversion — it yields nil when
/// the runtime type does not match — so <c>x as T</c> has type <c>T?</c>, not
/// <c>T</c>.
/// <para>
/// Typing it <c>T</c> let <c>let s string = o as string</c> bind, silently putting a
/// possibly-nil value into a non-nullable local, and it made ADR-0071's
/// <c>if let</c> / <c>guard let</c> reject the idiomatic
/// <c>if let s = x as T</c> with GS0296 (the initializer looked non-nullable, so the
/// binding had "nothing to strip").
/// </para>
/// </summary>
public class Adr0160AsOperatorNullableTests
{
    [Fact]
    public void AsResult_AssignedToNonNullableLocal_Diagnoses_GS0155()
    {
        // The whole point of the ADR: this used to bind, and was unsafe.
        var diagnostics = Bind(@"
func Run(o object) int32 {
    let s string = o as string
    return s.Length
}
");

        Assert.Contains(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void AsResult_AssignedToNullableLocal_Binds()
    {
        var diagnostics = Bind(@"
func Run(o object) int32 {
    let s string? = o as string
    if s != nil {
        return s.Length
    }
    return 0
}
");

        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// The reason the ADR exists: the canonical narrowing form over a testing
    /// conversion. Rejected with GS0296 before the change.
    /// </summary>
    [Fact]
    public void IfLet_OverAsExpression_Binds()
    {
        var diagnostics = Bind(@"
func Run(o object) int32 {
    if let s = o as string {
        return s.Length
    }
    return 0
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GuardLet_OverAsExpression_Binds()
    {
        var diagnostics = Bind(@"
func Run(o object) int32 {
    guard let s = o as string else { return 0 }
    return s.Length
}
");

        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// An already-nullable target must not be double-wrapped into <c>T??</c>.
    /// </summary>
    [Fact]
    public void AsNullableTarget_IsNotDoubleWrapped()
    {
        var diagnostics = Bind(@"
func Run(o object) int32 {
    let s string? = o as string?
    if let v = s {
        return v.Length
    }
    return 0
}
");

        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// A non-nullable value-type target stays illegal — <c>as</c> must be able to
    /// yield nil. This rule predates the ADR and now reads consistently with the
    /// result type.
    /// </summary>
    [Fact]
    public void AsNonNullableValueTypeTarget_StillRejected()
    {
        var diagnostics = Bind(@"
func Run(o object) int32 {
    let n = o as int32
    return 0
}
");

        Assert.NotEmpty(diagnostics);
    }

    /// <summary>
    /// `x as T ?? fallback` previously produced a BARE type-parameter LHS, which
    /// issue #1516 added dedicated emit paths for. It now produces
    /// `NullableTypeSymbol(T)` and routes through the pre-existing issue-#831
    /// probe instead; both must keep binding.
    /// </summary>
    [Fact]
    public void AsResult_CoalescedWithFallback_Binds()
    {
        var diagnostics = Bind(@"
func Run(o object) string {
    return (o as string) ?? ""fallback""
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void AsResult_NullAssertedAfterTest_Binds()
    {
        var diagnostics = Bind(@"
func Run(o object) int32 {
    if o is string {
        return (o as string)!!.Length
    }
    return 0
}
");

        Assert.Empty(diagnostics);
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
