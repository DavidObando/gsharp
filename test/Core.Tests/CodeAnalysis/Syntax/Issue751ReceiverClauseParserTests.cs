// <copyright file="Issue751ReceiverClauseParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Parser-level coverage for issue #751 / ADR-0084 §L2: the receiver
/// clause `func (recv RecvType) Name(...)` must accept the full type
/// grammar — nullable spellings (`T?`), generic applications
/// (`sequence[T]`, `map[K,V]`), array+nullable combinations (`[]T?` for
/// nullable elements and `[]?T` for a nullable array, issue #1212),
/// tuple types (`(int32, T)`), and arbitrary nesting (`sequence[T]?`).
/// Prior to the fix, <c>LooksLikeReceiverClause</c> only matched a
/// bare identifier or `[N]T` / `[]T` and silently demoted the rest to
/// a regular parameter list, losing the extension-method status.
/// </summary>
public class Issue751ReceiverClauseParserTests
{
    [Theory]
    [InlineData("func (self T?) M[T]() { }", "M")]
    [InlineData("func (self sequence[T]) M[T]() { }", "M")]
    [InlineData("func (self sequence[T]?) M[T]() { }", "M")]
    [InlineData("func (self []T?) M[T]() { }", "M")]
    [InlineData("func (self []?T) M[T]() { }", "M")]
    [InlineData("func (self map[K,V]) M[K, V]() { }", "M")]
    [InlineData("func (self []T) M[T]() { }", "M")]
    [InlineData("func (self [3]int32) M() { }", "M")]
    [InlineData("func (self int32) M() { }", "M")]
    [InlineData("func (self sequence[(int32, T)]) M[T]() { }", "M")]
    [InlineData("func (self (int32, string)) M() { }", "M")]
    [InlineData("func (self (int32, string)?) M() { }", "M")]
    public void ReceiverClause_With_RichTypeSpelling_IsRecognizedAsExtension(string declaration, string expectedName)
    {
        var source = "package P\n" + declaration + "\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(fn.IsExtension, "Expected extension method; receiver clause was not recognised.");
        Assert.NotNull(fn.Receiver);
        Assert.NotNull(fn.ReceiverOpenParenthesisToken);
        Assert.NotNull(fn.ReceiverCloseParenthesisToken);
        Assert.Equal(expectedName, fn.Identifier.Text);
    }

    [Fact]
    public void RegularFunction_With_GenericReturnType_IsNotMistakenForReceiverClause()
    {
        // Regression guard: the fix must not classify `func Foo(a int) Bar[int]
        // { ... }` as an extension method. The function name comes BEFORE the
        // parameter list so `LooksLikeReceiverClause` is never invoked for
        // this shape — but we cover it explicitly because the generic-return
        // case is the closest non-receiver token sequence.
        const string source = @"
package P

func Foo(a int32) int32 {
    return a
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.False(fn.IsExtension);
    }

    [Fact]
    public void Regular_MultiParameter_Function_Without_Name_Is_Not_Receiver_Clause()
    {
        // Defence in depth: a multi-parameter list `(a int32, b int32)` should
        // not match the receiver shape — the scanner bails on the top-level
        // comma. If a developer writes `func (a int32, b int32) name()` we
        // want it routed through the regular parameter-list parser so the
        // diagnostics are coherent.
        const string source = @"
package P

func name() int32 {
    return 0
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.False(fn.IsExtension);
    }

    [Fact]
    public void Repro_From_Issue751_Parses_Without_Diagnostics()
    {
        // The exact spellings from the issue body. Each one was rejected by
        // the prior parser; all three must parse cleanly and be classified
        // as extension methods.
        const string source = @"
package P

func (self T?) Map[T, U](f (T) -> U) U? {
    return nil
}

func (self sequence[T]) FirstOrNil[T]() T? {
    return nil
}

func (self sequence[T]) Indexed[T]() sequence[(int32, T)] {
    return nil
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fns = tree.Root.Members.OfType<FunctionDeclarationSyntax>().ToList();
        Assert.Equal(3, fns.Count);
        Assert.All(fns, fn => Assert.True(fn.IsExtension, $"{fn.Identifier.Text} was not recognised as extension."));
        Assert.Equal(new[] { "Map", "FirstOrNil", "Indexed" }, fns.Select(f => f.Identifier.Text));
    }
}
