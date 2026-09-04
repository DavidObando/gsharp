// <copyright file="Issue3880VariadicNamedArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3880 (self-migration wall in <c>tools/cs2gs/Cs2Gs.Tests</c>): a named
/// argument was allowed to address only the FIXED prefix of a variadic
/// function's parameter list. Naming the trailing variadic parameter itself —
/// <c>f(reason: "…", sources: ("Uri.cs", "…"))</c>, which is what C# spells for
/// a <c>params</c> parameter and what cs2gs therefore emits — reported GS0246
/// "named argument 'sources' does not match any parameter".
/// <para>
/// The argument is already sitting in the variadic parameter's own slot, so
/// nothing needs reordering; the value that follows is either the whole carrier
/// or a single expanded element, which the existing pack / pass-through path
/// decides on by type. Both spellings are covered below, and the results are
/// EVALUATED rather than merely bound — a name that resolved to the right
/// parameter but packed the wrong way would still bind clean.
/// </para>
/// </summary>
public class Issue3880VariadicNamedArgumentTests
{
    [Fact]
    public void NamedVariadicArgument_SingleElement_IsExpanded()
    {
        var result = EmittedOracle.Evaluate(@"
func total(scale int32, values ...int32) int32 {
    var t = 0
    for v in values {
        t = t + (v * scale)
    }
    return t
}
total(scale: 10, values: 7)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(70, result.Value);
    }

    [Fact]
    public void NamedVariadicArgument_WholeCarrier_IsPassedThrough()
    {
        // The pass-through half of the same call shape: the named value is the
        // carrier itself, not one element. Three elements distinguish it from
        // the expanded reading, which would have packed the slice as a single
        // element and failed to convert.
        var result = EmittedOracle.Evaluate(@"
func total(scale int32, values ...int32) int32 {
    var t = 0
    for v in values {
        t = t + (v * scale)
    }
    return t
}
total(scale: 2, values: []int32{1, 2, 3})
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void NamedVariadicArgument_OnAMethod_IsExpanded()
    {
        // The same rule reached through the method-call binding path rather
        // than the free-function one; they validate named arguments through
        // separate call sites into the shared helper.
        var result = EmittedOracle.Evaluate(@"
class Adder {
    func total(scale int32, values ...int32) int32 {
        var t = 0
        for v in values {
            t = t + (v * scale)
        }
        return t
    }
}
Adder().total(scale: 3, values: 5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15, result.Value);
    }

    [Fact]
    public void NamedVariadicArgument_MustStillBeTheLastArgument()
    {
        // Anti-vacuity: the fix accepts the variadic parameter's name in its
        // own slot as the LAST argument, which is all C# accepts for `params`.
        // Naming it and then continuing positionally stays an error, so this
        // is a narrowed rule and not a disabled one.
        var result = EmittedOracle.Evaluate(@"
func total(scale int32, values ...int32) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(scale: 1, values: 2, 3)
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0246");
    }

    [Fact]
    public void AnUnknownName_IsStillRejected()
    {
        // The other anti-vacuity guard: a name that matches no parameter at all
        // must keep reporting GS0246.
        var result = EmittedOracle.Evaluate(@"
func total(scale int32, values ...int32) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(scale: 1, nosuch: 2)
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0246");
    }
}
