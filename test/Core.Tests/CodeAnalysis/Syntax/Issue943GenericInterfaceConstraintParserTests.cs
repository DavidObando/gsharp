// <copyright file="Issue943GenericInterfaceConstraintParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #943: a type-parameter constraint that names a constructed generic
/// interface — e.g. <c>[T IComparable[T]]</c> — must parse without GS0005. The
/// regression was in <c>LooksLikeTypeParameterList</c>, whose lookahead failed
/// to skip the constraint's own generic-argument bracket segment and so
/// mis-classified the type-parameter list as an indexer. These tests assert the
/// shape round-trips and exposes the constraint identifier plus its type
/// arguments.
/// </summary>
public class Issue943GenericInterfaceConstraintParserTests
{
    [Fact]
    public void SelfReferentialGenericInterfaceConstraint_Parses_WithoutDiagnostics()
    {
        const string source = """
            package P
            import System
            func Max[T IComparable[T]](a T, b T) T {
                if a.CompareTo(b) > 0 { return a }
                return b
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.Equal("T", tp.Identifier.Text);
        Assert.Equal("IComparable", tp.Constraint.Text);
        Assert.Equal(1, tp.ConstraintTypeArguments.Count);
    }

    [Fact]
    public void GenericInterfaceConstraint_WithClosedTypeArgument_Parses()
    {
        const string source = """
            package P
            import System
            func F[T IComparable[int32]](x T) T { return x }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.Equal("IComparable", tp.Constraint.Text);
        Assert.Equal(1, tp.ConstraintTypeArguments.Count);
    }

    [Fact]
    public void NonGenericInterfaceConstraint_StillParses()
    {
        const string source = """
            package P
            import System
            func F[T IDisposable](x T) T { return x }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.Equal("IDisposable", tp.Constraint.Text);
        Assert.True(tp.ConstraintTypeArguments == null || tp.ConstraintTypeArguments.Count == 0);
    }

    private static TypeParameterSyntax FindFirstTypeParameter(SyntaxTree tree)
    {
        TypeParameterSyntax found = null;
        Walk(tree.Root);
        return found;

        void Walk(SyntaxNode node)
        {
            if (found != null)
            {
                return;
            }

            if (node is TypeParameterSyntax tp)
            {
                found = tp;
                return;
            }

            foreach (var c in node.GetChildren())
            {
                Walk(c);
            }
        }
    }
}
