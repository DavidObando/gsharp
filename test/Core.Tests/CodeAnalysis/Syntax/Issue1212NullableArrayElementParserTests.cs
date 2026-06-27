// <copyright file="Issue1212NullableArrayElementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1212: where the nullable <c>?</c> binds in an array/slice type clause.
/// <list type="bullet">
/// <item><c>[]T?</c> — the trailing <c>?</c> binds to the ELEMENT
/// (<see cref="TypeClauseSyntax.IsNullable"/> on the array clause; the array
/// itself is non-nullable).</item>
/// <item><c>[]?T</c> — a <c>?</c> right after <c>]</c> marks the whole array
/// nullable (<see cref="TypeClauseSyntax.IsArrayNullable"/>).</item>
/// <item><c>[]?T?</c> — both markers are present.</item>
/// </list>
/// Covers slices, fixed-length arrays, and jagged arrays.
/// </summary>
public class Issue1212NullableArrayElementParserTests
{
    private static TypeClauseSyntax LocalVarType(string typeText)
    {
        var source = $@"
package P
func Use() {{
    var x {typeText} = default({typeText})
}}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var varDecl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        Assert.NotNull(varDecl.TypeClause);
        return varDecl.TypeClause;
    }

    [Fact]
    public void ElementNullableSlice_BindsQuestionToElement()
    {
        var type = LocalVarType("[]int32?");

        Assert.True(type.IsSlice);
        Assert.True(type.IsNullable);          // trailing `?` -> element nullable
        Assert.False(type.IsArrayNullable);    // array itself is non-nullable
        Assert.Equal("int32", type.Identifier.Text);
    }

    [Fact]
    public void NullableArraySlice_BindsQuestionToArray()
    {
        var type = LocalVarType("[]?int32");

        Assert.True(type.IsSlice);
        Assert.False(type.IsNullable);         // element is non-nullable
        Assert.True(type.IsArrayNullable);     // `?` after `]` -> array nullable
        Assert.Equal("int32", type.Identifier.Text);
    }

    [Fact]
    public void NullableArrayOfNullableElements_HasBothMarkers()
    {
        var type = LocalVarType("[]?int32?");

        Assert.True(type.IsSlice);
        Assert.True(type.IsNullable);          // trailing `?` -> element nullable
        Assert.True(type.IsArrayNullable);     // leading `?` -> array nullable
        Assert.Equal("int32", type.Identifier.Text);
    }

    [Fact]
    public void ElementNullableFixedArray_BindsQuestionToElement()
    {
        var type = LocalVarType("[3]int32?");

        Assert.True(type.IsArray);
        Assert.False(type.IsSlice);
        Assert.True(type.IsNullable);
        Assert.False(type.IsArrayNullable);
        Assert.Equal("3", type.LengthToken.Text);
        Assert.Equal("int32", type.Identifier.Text);
    }

    [Fact]
    public void NullableFixedArray_BindsQuestionToArray()
    {
        var type = LocalVarType("[3]?int32");

        Assert.True(type.IsArray);
        Assert.False(type.IsSlice);
        Assert.False(type.IsNullable);
        Assert.True(type.IsArrayNullable);
        Assert.Equal("3", type.LengthToken.Text);
        Assert.Equal("int32", type.Identifier.Text);
    }

    [Fact]
    public void JaggedSliceOfNullableElements_BindsInnerElementNullable()
    {
        // `[][]int32?` — the trailing `?` binds to the innermost element.
        var type = LocalVarType("[][]int32?");

        Assert.True(type.IsSlice);
        Assert.False(type.IsNullable);
        Assert.False(type.IsArrayNullable);
        Assert.True(type.HasNestedArrayElement);

        var inner = type.ArrayElementType;
        Assert.True(inner.IsSlice);
        Assert.True(inner.IsNullable);         // inner `[]int32?` element nullable
        Assert.False(inner.IsArrayNullable);
        Assert.Equal("int32", inner.Identifier.Text);
    }

    [Fact]
    public void NullableArrayOfNestedElement_BindsOuterArrayNullable()
    {
        // `[]?*int32` — the outer slice reference is nullable; the element is a
        // nested (pointer) type clause. (A nested *slice* element `[]?[]T` is
        // not spellable because `?[` lexes as the null-conditional index token.)
        var type = LocalVarType("[]?*int32");

        Assert.True(type.IsSlice);
        Assert.True(type.IsArrayNullable);
        Assert.False(type.IsNullable);
        Assert.True(type.HasNestedArrayElement);

        var inner = type.ArrayElementType;
        Assert.True(inner.IsPointer);
        Assert.False(inner.IsArrayNullable);
        Assert.False(inner.IsNullable);
    }
}
