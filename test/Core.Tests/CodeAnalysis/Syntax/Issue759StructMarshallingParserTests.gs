// <copyright file="Issue759StructMarshallingParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser-level coverage for ADR-0093 / issue #759 struct- and
/// class-marshalling annotations: `@StructLayout(LayoutKind.…)` on
/// the type declaration and `@FieldOffset(N)` on field declarations.
/// The parser intentionally stays permissive — the binder enforces the
/// Sequential/Explicit/Auto rules and the per-field offset shape with the
/// GS0346–GS0350 diagnostics.
open class Issue759StructMarshallingParserTests {
    @Fact
    func StructLayout_Annotation_On_Sequential_Struct_Parses_Without_Diagnostics() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let annotation = Assert.Single(structDecl.Annotations)
        Assert.Equal("StructLayout", annotation.GetNameText())
        Assert.True(annotation.HasArgumentList)
    }

    @Fact
    func StructLayout_Explicit_With_FieldOffsets_Parses_Without_Diagnostics() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 16)
struct LargeIntegerUnion {
    @FieldOffset(0) var LowPart uint32
    @FieldOffset(4) var HighPart int32
    @FieldOffset(0) var QuadPart int64
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Single(structDecl.Annotations)
        Assert.Equal(3, structDecl.Fields.Length)
        for field in structDecl.Fields {
            let fieldAnn = Assert.Single(field.Annotations)
            Assert.Equal("FieldOffset", fieldAnn.GetNameText())
        }
    }

    @Fact
    func StructLayout_Annotation_On_Class_Parses_Without_Diagnostics() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
class NativeContext {
    var Handle nint
    var Flags int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let classDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(classDecl.IsClass)
        Assert.Single(classDecl.Annotations)
    }

    @Fact
    func FieldOffset_With_Integer_Literal_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit)
struct Pair {
    @FieldOffset(0) var First int32
    @FieldOffset(8) var Second int64
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Equal(2, structDecl.Fields.Length)
    }
}
