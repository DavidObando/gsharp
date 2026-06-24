// <copyright file="Issue1046JaggedArrayParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1046: the array/slice type clause <c>[]T</c> previously required the
/// element <c>T</c> to be a bare (qualified, possibly generic) identifier, so
/// jagged arrays <c>[][]T</c>, arrays of pointers <c>[]*T</c> and arrays of
/// maps <c>[]map[K]V</c> failed to parse with GS0005. The element is now a full
/// nested <see cref="TypeClauseSyntax"/> (mirroring the pointer/chan/map element
/// recursion). These tests cover the parser layer; binding/runtime behaviour is
/// covered by emit tests in test/Compiler.Tests/Emit/.
/// </summary>
public class Issue1046JaggedArrayParserTests
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
    public void JaggedSlice_InVarDeclaration_Parses_AsNestedSliceElement()
    {
        // The exact repro from the issue body: `var x [][]uint8 = default(...)`.
        var type = LocalVarType("[][]uint8");

        Assert.True(type.IsArray);
        Assert.True(type.IsSlice);
        Assert.True(type.HasNestedArrayElement);

        var inner = type.ArrayElementType;
        Assert.NotNull(inner);
        Assert.True(inner.IsSlice);
        Assert.False(inner.HasNestedArrayElement);
        Assert.Equal("uint8", inner.Identifier.Text);
    }

    [Fact]
    public void TripleNestedSlice_Parses_TwoLevelsDeep()
    {
        var type = LocalVarType("[][][]int32");

        Assert.True(type.IsSlice);
        Assert.True(type.HasNestedArrayElement);
        var lvl2 = type.ArrayElementType;
        Assert.True(lvl2.IsSlice);
        Assert.True(lvl2.HasNestedArrayElement);
        var lvl3 = lvl2.ArrayElementType;
        Assert.True(lvl3.IsSlice);
        Assert.False(lvl3.HasNestedArrayElement);
        Assert.Equal("int32", lvl3.Identifier.Text);
    }

    [Fact]
    public void SizedJaggedArray_Parses_WithLengthAndNestedSliceElement()
    {
        var type = LocalVarType("[3][]uint8");

        Assert.True(type.IsArray);
        Assert.False(type.IsSlice);
        Assert.NotNull(type.LengthToken);
        Assert.True(type.HasNestedArrayElement);
        Assert.True(type.ArrayElementType.IsSlice);
    }

    [Fact]
    public void ArrayOfMap_Parses_WithNestedMapElement()
    {
        var type = LocalVarType("[]map[string,int32]");

        Assert.True(type.IsSlice);
        Assert.True(type.HasNestedArrayElement);
        Assert.True(type.ArrayElementType.IsMap);
    }

    [Fact]
    public void ArrayOfChannel_Parses_WithNestedChannelElement()
    {
        var type = LocalVarType("[]chan int32");

        Assert.True(type.IsSlice);
        Assert.True(type.HasNestedArrayElement);
        Assert.True(type.ArrayElementType.IsChannel);
    }

    [Fact]
    public void ArrayOfPointer_Parses_WithNestedPointerElement()
    {
        var type = LocalVarType("[]*int32");

        Assert.True(type.IsSlice);
        Assert.True(type.HasNestedArrayElement);
        Assert.True(type.ArrayElementType.IsPointer);
    }

    [Fact]
    public void JaggedSlice_InParameterPosition_Parses()
    {
        const string source = @"
package P
func Use(grid [][]uint8) {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var param = fn.Parameters.Single();
        Assert.True(param.Type.IsSlice);
        Assert.True(param.Type.HasNestedArrayElement);
        Assert.True(param.Type.ArrayElementType.IsSlice);
    }

    [Fact]
    public void JaggedSlice_InReturnPosition_Parses()
    {
        const string source = @"
package P
func Make() [][]uint8 {
    return default([][]uint8)
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(fn.Type.IsSlice);
        Assert.True(fn.Type.HasNestedArrayElement);
        Assert.True(fn.Type.ArrayElementType.IsSlice);
    }

    [Fact]
    public void JaggedSlice_InFieldPosition_Parses()
    {
        const string source = @"
package P
class Grid {
    var Cells [][]uint8
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void JaggedSlice_InIsPattern_Parses()
    {
        const string source = @"
package P
func Use(o object) bool {
    return o is [][]uint8
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    // ---- Regression: existing element forms must still parse the flat path. ----

    [Fact]
    public void SingleSlice_OfIdentifier_StillParses_Flat()
    {
        var type = LocalVarType("[]uint8");

        Assert.True(type.IsSlice);
        Assert.False(type.HasNestedArrayElement);
        Assert.Equal("uint8", type.Identifier.Text);
    }

    [Fact]
    public void Slice_OfQualifiedName_StillParses_Flat()
    {
        var type = LocalVarType("[]Outer.Inner");

        Assert.True(type.IsSlice);
        Assert.False(type.HasNestedArrayElement);
        Assert.Equal("Outer", type.Identifier.Text);
        Assert.Equal("Outer.Inner", type.DottedName);
    }

    [Fact]
    public void Slice_OfGenericName_StillParses_Flat()
    {
        var type = LocalVarType("[]List[int32]");

        Assert.True(type.IsSlice);
        Assert.False(type.HasNestedArrayElement);
        Assert.Equal("List", type.Identifier.Text);
        Assert.True(type.HasTypeArguments);
    }

    [Fact]
    public void Pointer_OfIdentifier_StillParses()
    {
        var type = LocalVarType("*int32");

        Assert.True(type.IsPointer);
        Assert.False(type.IsArray);
        Assert.NotNull(type.PointerPointeeType);
    }

    [Fact]
    public void Map_StillParses()
    {
        var type = LocalVarType("map[string,int32]");

        Assert.True(type.IsMap);
        Assert.False(type.IsArray);
    }
}
