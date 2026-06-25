// <copyright file="Issue775ConstraintParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0097 / issue #775: parser-side acceptance tests for the new
/// <c>class</c> / <c>struct</c> / <c>init()</c> type-parameter
/// constraint spellings (the default-constructor constraint was renamed
/// from <c>new()</c> to <c>init()</c> by issue #997). The parser must
/// round-trip each spelling (including all legal combinations) without
/// diagnostics, must reach the <see cref="TypeParameterSyntax"/> node and
/// expose the correct boolean flags, and must not regress on the legacy
/// spellings (<c>any</c>, <c>comparable</c>, sealed-interface name, generic-bound
/// shape <c>[T IAdd[T]]</c>).
/// </summary>
public class Issue775ConstraintParserTests
{
    [Fact]
    public void ClassConstraint_Parses_AndExposesFlag()
    {
        const string source = "func F[T class](x T) T { return x }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.True(tp.HasClassConstraint);
        Assert.False(tp.HasStructConstraint);
        Assert.False(tp.HasInitConstraint);
        Assert.Null(tp.Constraint);
    }

    [Fact]
    public void StructConstraint_Parses_AndExposesFlag()
    {
        const string source = "func F[T struct](x T) T { return x }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.False(tp.HasClassConstraint);
        Assert.True(tp.HasStructConstraint);
        Assert.False(tp.HasInitConstraint);
    }

    [Fact]
    public void InitConstraint_Parses_AndExposesFlag()
    {
        const string source = "func F[T init()](x T) T { return x }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.False(tp.HasClassConstraint);
        Assert.False(tp.HasStructConstraint);
        Assert.True(tp.HasInitConstraint);
        Assert.NotNull(tp.InitConstraintOpenParenToken);
        Assert.NotNull(tp.InitConstraintCloseParenToken);
    }

    [Fact]
    public void ClassAndInitConstraint_Combined_Parses()
    {
        const string source = "func F[T class init()](x T) T { return x }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.True(tp.HasClassConstraint);
        Assert.True(tp.HasInitConstraint);
    }

    [Fact]
    public void InterfaceAndClassConstraint_Combined_Parses()
    {
        const string source = """
            package P
            sealed interface IFoo { func M(); }
            func F[T IFoo class](x T) T { return x }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.NotNull(tp.Constraint);
        Assert.Equal("IFoo", tp.Constraint.Text);
        Assert.True(tp.HasClassConstraint);
    }

    [Fact]
    public void TwoTypeParameters_DifferentConstraints_Parse()
    {
        const string source = "func F[T class, U struct](x T, y U) T { return x }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var typeParams = FindAllTypeParameters(tree);
        Assert.Equal(2, typeParams.Count);
        Assert.True(typeParams[0].HasClassConstraint);
        Assert.False(typeParams[0].HasStructConstraint);
        Assert.False(typeParams[1].HasClassConstraint);
        Assert.True(typeParams[1].HasStructConstraint);
    }

    [Fact]
    public void LegacyAnyConstraint_StillParses()
    {
        const string source = "func F[T any](x T) T { return x }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.NotNull(tp.Constraint);
        Assert.Equal("any", tp.Constraint.Text);
        Assert.False(tp.HasClassConstraint);
        Assert.False(tp.HasStructConstraint);
        Assert.False(tp.HasInitConstraint);
    }

    [Fact]
    public void LegacyComparableConstraint_StillParses()
    {
        const string source = "func F[T comparable](a T, b T) bool { return a == b }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.Equal("comparable", tp.Constraint.Text);
    }

    [Fact]
    public void ClassConstraint_OnClassDeclaration_Parses()
    {
        const string source = """
            package P
            class Box[T class] {
                var v T
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void StructConstraint_OnDataStruct_Parses()
    {
        const string source = """
            package P
            data struct Holder[T struct] { var v T }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void InitConstraint_OnClassDeclaration_Parses()
    {
        const string source = """
            package P
            class Box[T init()] {
                var v T
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.True(tp.HasInitConstraint);
    }

    [Fact]
    public void InitCtorDeclaration_StillParses_NoRegressionFromInitConstraint()
    {
        // Issue #997 guard: adding `init()` as a contextual constraint keyword
        // (only inside a generic parameter list) must NOT break the existing
        // `init(...)` constructor declaration syntax in a class body.
        const string source = """
            package P
            class Rect {
                var Width int32
                var Height int32
                init(w int32, h int32) {
                    Width = w
                    Height = h
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void InitOnlyProperty_StillParses_NoRegressionFromInitConstraint()
    {
        // Issue #997 guard: the `init` accessor of an init-only property must
        // still parse correctly after `init()` becomes a constraint keyword.
        const string source = """
            package P
            class Box {
                prop X int32 { get; init; }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void InitConstraint_WithInitCtor_BothParseTogether()
    {
        // Issue #997: a generic class can carry an `init()` constraint on its
        // type parameter AND declare an `init(...)` constructor in its body.
        const string source = """
            package P
            class Box[T init()] {
                var v T
                init(value T) {
                    v = value
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.True(tp.HasInitConstraint);
    }

    private static TypeParameterSyntax FindFirstTypeParameter(SyntaxTree tree)
    {
        return FindAllTypeParameters(tree).First();
    }

    private static System.Collections.Generic.List<TypeParameterSyntax> FindAllTypeParameters(SyntaxTree tree)
    {
        var results = new System.Collections.Generic.List<TypeParameterSyntax>();
        Walk(tree.Root);
        return results;

        void Walk(SyntaxNode node)
        {
            if (node is TypeParameterSyntax tp)
            {
                results.Add(tp);
            }

            foreach (var c in node.GetChildren())
            {
                Walk(c);
            }
        }
    }
}
