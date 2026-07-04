// <copyright file="Issue1924CompositeTypeArgumentInExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1924: a composite type argument (an array/slice shape <c>[]T</c>, or
/// a dotted/qualified name <c>Outer.Inner</c>) parsed fine in TYPE position
/// (<c>var x []Task[int32]</c>, per issue #1046 / #526) but failed with
/// GS0005 ("Unexpected token &lt;CloseSquareBracketToken&gt;, expected
/// &lt;IdentifierToken&gt;") in EXPRESSION position for the array-of-generic
/// literal (<c>[]Task[int32]{ … }</c>) and array-of-qualified-name literal
/// (<c>[]Outer.Inner{ … }</c>).
/// <para>
/// Root cause: <c>ParseArrayCreationExpression</c>'s flat-identifier fast path
/// matched the element type as a single <see cref="SyntaxToken"/> and jumped
/// straight to the <c>{</c> initializer, never consuming a trailing
/// <c>[T, ...]</c> type-argument list or <c>.Member</c> qualifier tail on the
/// element name. The nested/jagged-element path (issue #1046) already routes
/// through the general <c>ParseTypeClause()</c>, which handles both shapes
/// (see <c>Issue1046JaggedArrayParserTests.Slice_OfGenericName_StillParses_Flat</c>
/// and <c>Slice_OfQualifiedName_StillParses_Flat</c> for the TYPE-position
/// equivalents); the fix widens the "route through <c>ParseTypeClause()</c>"
/// condition to also fire when the element identifier is followed by <c>[</c>
/// or <c>.</c>, generalizing the fix to the whole family of composite type
/// arguments (not just the two examples from the issue body).
/// </para>
/// <para>
/// The other reported repro, <c>List[[]object]{ … }</c> (a composite array
/// type ARGUMENT to a generic collection literal, as opposed to an array-OF-
/// generic literal), already parsed correctly before this fix — the
/// generic-call-site disambiguation (<c>LooksLikeGenericCallSite</c> /
/// <c>TryScanTypeClause</c>) already recurses into a bracketed type argument
/// that itself starts with <c>[]</c>. Coverage for that shape is included here
/// too, to lock in the whole family per the issue's "generalize, don't
/// special-case" convention.
/// </para>
/// </summary>
public class Issue1924CompositeTypeArgumentInExpressionParserTests
{
    private static ArrayCreationExpressionSyntax GetArrayCreation(string initializer)
    {
        var tree = SyntaxTree.Parse($"package P\nlet x = {initializer}\n");
        Assert.Empty(tree.Diagnostics);
        var decl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        return Assert.IsType<ArrayCreationExpressionSyntax>(decl.Initializer);
    }

    [Fact]
    public void ArrayOfGeneric_Literal_Parses_WithNestedElementTypeClause()
    {
        // The exact repro from the issue body: `[]Task[int32]{…}`.
        var creation = GetArrayCreation("[]Task[int32]{Foo(), Bar()}");

        Assert.True(creation.HasNestedElementTypeClause);
        Assert.Null(creation.ElementTypeIdentifier);
        Assert.Equal(2, creation.Elements.Count);

        var elementType = creation.ElementTypeClause;
        Assert.Equal("Task", elementType.Identifier.Text);
        Assert.True(elementType.HasTypeArguments);
        Assert.Single(elementType.TypeArguments);
        Assert.Equal("int32", elementType.TypeArguments[0].Identifier.Text);
    }

    [Fact]
    public void ArrayOfGeneric_Literal_WithMultipleTypeArguments_Parses()
    {
        var creation = GetArrayCreation("[]Dictionary[string, int32]{Make()}");

        Assert.True(creation.HasNestedElementTypeClause);
        Assert.Equal("Dictionary", creation.ElementTypeClause.Identifier.Text);
        Assert.Equal(2, creation.ElementTypeClause.TypeArguments.Count);
    }

    [Fact]
    public void ArrayOfQualifiedName_Literal_Parses_WithNestedElementTypeClause()
    {
        var creation = GetArrayCreation("[]Outer.Inner{Make()}");

        Assert.True(creation.HasNestedElementTypeClause);
        Assert.Null(creation.ElementTypeIdentifier);

        var elementType = creation.ElementTypeClause;
        Assert.Equal("Outer.Inner", elementType.DottedName);
    }

    [Fact]
    public void SizedArrayOfGeneric_Literal_Parses()
    {
        var creation = GetArrayCreation("[2]Task[int32]{Foo(), Bar()}");

        Assert.False(creation.IsRuntimeLengthAllocation);
        Assert.True(creation.HasNestedElementTypeClause);
        Assert.Equal("Task", creation.ElementTypeClause.Identifier.Text);
    }

    [Fact]
    public void ArrayOfGeneric_NoInitializer_RuntimeAllocationForm_Parses()
    {
        var creation = GetArrayCreation("[n]Task[int32]");

        Assert.True(creation.IsRuntimeLengthAllocation);
        Assert.True(creation.HasNestedElementTypeClause);
        Assert.False(creation.HasInitializer);
        Assert.Equal("Task", creation.ElementTypeClause.Identifier.Text);
    }

    // ---- Regression: existing plain-identifier element forms are unaffected. ----

    [Fact]
    public void ArrayOfPlainIdentifier_Literal_StillParses_Flat()
    {
        var creation = GetArrayCreation("[]int32{1, 2, 3}");

        Assert.False(creation.HasNestedElementTypeClause);
        Assert.Equal("int32", creation.ElementTypeIdentifier.Text);
        Assert.Equal(3, creation.Elements.Count);
    }

    [Fact]
    public void ArrayOfNullableIdentifier_Literal_StillParses()
    {
        var tree = SyntaxTree.Parse("package P\nlet x = []int32?{1, 2}\n");
        Assert.Empty(tree.Diagnostics);
    }

    // ---- The other reported shape: a composite array TYPE ARGUMENT to a ----
    // ---- generic collection literal (`List[[]object]{…}`).              ----

    [Fact]
    public void GenericCollectionLiteral_WithArrayTypeArgument_Parses()
    {
        const string source = @"
package P
func Use() {
    var a1 = []object{1, ""two""}
    var xs = List[[]object]{a1, a1}
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GenericCollectionLiteral_WithArrayTypeArgument_ParsesAsCollectionInitializer()
    {
        const string source = @"
package P
func Use() {
    var a1 = []object{1}
    var xs = List[[]object]{a1}
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var xsDecl = fn.Body.Statements
            .OfType<VariableDeclarationSyntax>()
            .Single(d => d.Identifier.Text == "xs");

        var init = Assert.IsType<CollectionInitializerExpressionSyntax>(xsDecl.Initializer);
        var target = Assert.IsType<CallExpressionSyntax>(init.Target);
        Assert.Equal("List", target.Identifier.Text);
        Assert.NotNull(target.TypeArgumentList);
        var typeArg = Assert.Single(target.TypeArgumentList.Arguments);
        Assert.True(typeArg.IsSlice);
        Assert.Equal("object", typeArg.Identifier.Text);
    }
}
