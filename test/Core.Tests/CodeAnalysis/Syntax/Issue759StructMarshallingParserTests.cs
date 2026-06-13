// <copyright file="Issue759StructMarshallingParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Parser-level coverage for ADR-0093 / issue #759 struct- and
/// class-marshalling annotations: <c>@StructLayout(LayoutKind.…)</c> on
/// the type declaration and <c>@FieldOffset(N)</c> on field declarations.
/// The parser intentionally stays permissive — the binder enforces the
/// Sequential/Explicit/Auto rules and the per-field offset shape with the
/// GS0346–GS0350 diagnostics.
/// </summary>
public class Issue759StructMarshallingParserTests
{
    [Fact]
    public void StructLayout_Annotation_On_Sequential_Struct_Parses_Without_Diagnostics()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var annotation = Assert.Single(structDecl.Annotations);
        Assert.Equal("StructLayout", annotation.GetNameText());
        Assert.True(annotation.HasArgumentList);
    }

    [Fact]
    public void StructLayout_Explicit_With_FieldOffsets_Parses_Without_Diagnostics()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 16)
struct LargeIntegerUnion {
    @FieldOffset(0) var LowPart uint32
    @FieldOffset(4) var HighPart int32
    @FieldOffset(0) var QuadPart int64
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Single(structDecl.Annotations);
        Assert.Equal(3, structDecl.Fields.Length);
        foreach (var field in structDecl.Fields)
        {
            var fieldAnn = Assert.Single(field.Annotations);
            Assert.Equal("FieldOffset", fieldAnn.GetNameText());
        }
    }

    [Fact]
    public void StructLayout_Annotation_On_Class_Parses_Without_Diagnostics()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
class NativeContext {
    var Handle nint
    var Flags int32
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var classDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(classDecl.IsClass);
        Assert.Single(classDecl.Annotations);
    }

    [Fact]
    public void FieldOffset_With_Integer_Literal_Parses()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
struct Pair {
    @FieldOffset(0) var First int32
    @FieldOffset(8) var Second int64
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Equal(2, structDecl.Fields.Length);
    }
}
