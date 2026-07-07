// <copyright file="Issue2209GenericFqnStaticAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #2209: static member access through a
/// fully-qualified GENERIC type name (<c>Ns.Sub.Generic[Args].StaticMember</c>)
/// failed with GS0157 ("Cannot find type System") because
/// <c>TryBindImportAccessor</c>'s dotted-namespace walk only recognised a
/// plain <see cref="NameExpressionSyntax"/> segment; a generic-instantiation
/// segment (<c>Comparer[int32]</c>, parsed as an <see cref="IndexExpressionSyntax"/>
/// or a <see cref="GenericNameExpressionSyntax"/>) fell through to the
/// default case and aborted the whole walk at the FIRST segment
/// (<c>System</c>). The non-generic FQN static-access form
/// (<c>System.Text.Encoding.UTF8</c>) and the FQN generic CONSTRUCTION form
/// (<c>System.Collections.Generic.List[int32]()</c>) already worked; this bug
/// was isolated to the generic-instantiation + static-member combination.
/// </summary>
public class Issue2209GenericFqnStaticAccessTests
{
    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }

    [Fact]
    public void QualifiedGenericComparerDefault_Compare_Binds()
    {
        // The exact repro from the issue.
        var source = """
            package T
            func F() int32 { return System.Collections.Generic.Comparer[int32].Default.Compare(1, 2) }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UnqualifiedGenericComparerDefault_Compare_StillBinds_Control()
    {
        // Control: the same code with an import already worked before the fix
        // and must keep working after it.
        var source = """
            package T
            import System.Collections.Generic
            func F() int32 { return Comparer[int32].Default.Compare(1, 2) }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void QualifiedGenericEqualityComparerDefault_Equals_Binds()
    {
        // Variation: a different imported generic type, and a further member
        // access (`.Equals`) chained after the static member (`.Default`) —
        // mirrors the real-world CommunityToolkit.Mvvm-generated shape from
        // the issue (`EqualityComparer<T>.Default.Equals(...)`).
        var source = """
            package T
            func F(message string, value string) bool {
                return System.Collections.Generic.EqualityComparer[string].Default.Equals(message, value)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void QualifiedGenericImmutableDictionaryEmpty_Count_Binds()
    {
        // Variation: a two-type-argument generic (different arity than the
        // repro's single-argument `Comparer[int32]`), plus a further member
        // access chained after the static member.
        var source = """
            package T
            func F() int32 { return System.Collections.Immutable.ImmutableDictionary[string, int32].Empty.Count }
            """;

        Assert.Empty(Bind(source));
    }
}
