// <copyright file="Issue1506PerSegmentTypeArgumentParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1506: the type-clause grammar must record a type-argument list
/// <em>per qualifier segment</em> so a nested type of a <em>constructed</em>
/// generic — <c>List[int32].Enumerator</c>,
/// <c>Dictionary[string, int32].Enumerator</c>, <c>A[T].B[U].C</c> — parses.
/// These tests pin the parser/syntax-model layer only: type resolution is
/// covered by the binder and end-to-end emit tests. They also assert that the
/// pre-existing single-trailing-argument (<c>Outer.Generic[int]</c>) and
/// non-generic dotted (<c>Outer.Inner</c>) forms are recorded identically to
/// before (no per-segment outer arguments).
/// </summary>
public class Issue1506PerSegmentTypeArgumentParserTests
{
    private static TypeClauseSyntax ParseLocalTypeClause(string typeText)
    {
        var source = $@"
package P
func Use() {{
    var x {typeText} = nil
}}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var varDecl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        return varDecl.TypeClause;
    }

    [Fact]
    public void ListEnumerator_RecordsOuterSegmentTypeArguments()
    {
        // `List[int32].Enumerator` — the single argument list attaches to the
        // OUTER (`List`) segment, and the last (`Enumerator`) segment carries
        // none. This is exactly the shape that previously failed to parse.
        var type = ParseLocalTypeClause("List[int32].Enumerator");

        Assert.Equal("List", type.Identifier.Text);
        Assert.Single(type.QualifierIdentifierTokens);
        Assert.Equal("Enumerator", type.QualifierIdentifierTokens[0].Text);
        Assert.Equal("List.Enumerator", type.DottedName);
        Assert.Equal(2, type.SegmentCount);

        Assert.True(type.HasOuterSegmentTypeArguments);
        Assert.True(type.SegmentHasTypeArguments(0));
        var outerArgs = type.GetSegmentTypeArguments(0);
        Assert.NotNull(outerArgs);
        Assert.Single(outerArgs);
        Assert.Equal("int32", outerArgs[0].Identifier.Text);

        // The last segment carries no arguments, so the legacy trailing-args
        // channel is empty.
        Assert.False(type.HasTypeArguments);
        Assert.False(type.SegmentHasTypeArguments(1));
        Assert.Null(type.GetSegmentTypeArguments(1));
    }

    [Fact]
    public void DictionaryEnumerator_RecordsMultipleOuterSegmentTypeArguments()
    {
        // `Dictionary[string, int32].Enumerator` — two arguments on the outer
        // segment, none on the nested tail.
        var type = ParseLocalTypeClause("Dictionary[string, int32].Enumerator");

        Assert.Equal("Dictionary", type.Identifier.Text);
        Assert.Equal("Dictionary.Enumerator", type.DottedName);
        Assert.True(type.HasOuterSegmentTypeArguments);

        var outerArgs = type.GetSegmentTypeArguments(0);
        Assert.Equal(2, outerArgs.Count);
        Assert.Equal("string", outerArgs[0].Identifier.Text);
        Assert.Equal("int32", outerArgs[1].Identifier.Text);
        Assert.False(type.SegmentHasTypeArguments(1));
    }

    [Fact]
    public void ThreeLevelPerSegment_RecordsArgumentsOnEachOuterSegment()
    {
        // `A[T].B[U].C` — arguments on both outer segments (`A`, `B`) and none
        // on the deepest (`C`).
        var type = ParseLocalTypeClause("A[T].B[U].C");

        Assert.Equal("A", type.Identifier.Text);
        Assert.Equal(2, type.QualifierIdentifierTokens.Length);
        Assert.Equal("B", type.QualifierIdentifierTokens[0].Text);
        Assert.Equal("C", type.QualifierIdentifierTokens[1].Text);
        Assert.Equal(3, type.SegmentCount);
        Assert.Equal("A.B.C", type.DottedName);

        Assert.True(type.HasOuterSegmentTypeArguments);
        Assert.True(type.SegmentHasTypeArguments(0));
        Assert.Equal("T", type.GetSegmentTypeArguments(0)[0].Identifier.Text);
        Assert.True(type.SegmentHasTypeArguments(1));
        Assert.Equal("U", type.GetSegmentTypeArguments(1)[0].Identifier.Text);
        Assert.False(type.SegmentHasTypeArguments(2));
    }

    [Fact]
    public void PerSegment_MixedGenericAndTrailingArguments_Parses()
    {
        // `A[T].B[U]` — the deepest segment ALSO carries arguments (via the
        // legacy trailing channel), while `A` carries per-segment outer args.
        var type = ParseLocalTypeClause("A[T].B[U]");

        Assert.Equal(2, type.SegmentCount);
        Assert.True(type.HasOuterSegmentTypeArguments);
        Assert.True(type.SegmentHasTypeArguments(0));
        Assert.Equal("T", type.GetSegmentTypeArguments(0)[0].Identifier.Text);

        // The last (`B`) segment's arguments still flow through the existing
        // trailing TypeArguments channel.
        Assert.True(type.HasTypeArguments);
        Assert.True(type.SegmentHasTypeArguments(1));
        Assert.Equal("U", type.GetSegmentTypeArguments(1)[0].Identifier.Text);
    }

    [Fact]
    public void DeepestGeneric_TrailingArguments_RecordedIdenticallyToBefore()
    {
        // Regression: `Outer.Generic[int]` — arguments on the LAST segment only.
        // These must continue to flow through the existing trailing channel with
        // NO per-segment outer arguments recorded, so no existing caller/test
        // that reads `TypeArguments`/`HasTypeArguments` regresses.
        var type = ParseLocalTypeClause("Outer.Generic[int]");

        Assert.Equal("Outer", type.Identifier.Text);
        Assert.Single(type.QualifierIdentifierTokens);
        Assert.Equal("Generic", type.QualifierIdentifierTokens[0].Text);

        Assert.False(type.HasOuterSegmentTypeArguments);
        Assert.False(type.SegmentHasTypeArguments(0));
        Assert.Null(type.GetSegmentTypeArguments(0));

        Assert.True(type.HasTypeArguments);
        Assert.True(type.SegmentHasTypeArguments(1));
        Assert.Single(type.TypeArguments);
        Assert.Equal("int", type.TypeArguments[0].Identifier.Text);
    }

    [Fact]
    public void NonGenericDotted_RecordedIdenticallyToBefore()
    {
        // Regression: `Outer.Inner` — no arguments anywhere.
        var type = ParseLocalTypeClause("Outer.Inner");

        Assert.Equal("Outer.Inner", type.DottedName);
        Assert.False(type.HasOuterSegmentTypeArguments);
        Assert.False(type.HasTypeArguments);
        Assert.False(type.SegmentHasTypeArguments(0));
        Assert.False(type.SegmentHasTypeArguments(1));
    }

    [Fact]
    public void SimpleGeneric_RecordedIdenticallyToBefore()
    {
        // Regression: `List[int32]` — a single generic segment with no dot. The
        // arguments live in the trailing channel and no outer segments exist.
        var type = ParseLocalTypeClause("List[int32]");

        Assert.Equal("List", type.Identifier.Text);
        Assert.Empty(type.QualifierIdentifierTokens);
        Assert.Equal(1, type.SegmentCount);
        Assert.False(type.HasOuterSegmentTypeArguments);
        Assert.True(type.HasTypeArguments);
        Assert.True(type.SegmentHasTypeArguments(0));
        Assert.Equal("int32", type.GetSegmentTypeArguments(0)[0].Identifier.Text);
    }

    [Fact]
    public void PerSegment_ParsesInParameterAndReturnPositions()
    {
        // The per-segment form must parse in every type-clause position, not
        // just locals. Parameter + return positions are exercised here; field
        // position is covered by the binder/emit suites.
        const string source = @"
package P
func F(e List[int32].Enumerator) Dictionary[string, int32].Enumerator {
    return nil
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var param = fn.Parameters.Single();
        Assert.True(param.Type.HasOuterSegmentTypeArguments);
        Assert.Equal("List.Enumerator", param.Type.DottedName);

        Assert.NotNull(fn.Type);
        Assert.True(fn.Type.HasOuterSegmentTypeArguments);
        Assert.Equal("Dictionary.Enumerator", fn.Type.DottedName);
    }
}
