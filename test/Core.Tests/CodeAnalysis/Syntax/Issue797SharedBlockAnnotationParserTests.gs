// <copyright file="Issue797SharedBlockAnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #797: parser support for Kotlin-style `@Foo` annotations
/// (ADR-0047 §3) on members declared inside a `shared { … }` block
/// (ADR-0053). The top-level / instance-member surface accepts `@Foo`
/// lead-ins on every member kind; before #797 the shared-block parser
/// treated a leading `@` as the start of a field declaration and
/// rejected programs like
/// `shared { @MethodImpl(...) func Range(...) sequence[int32] { ... } }`.
open class Issue797SharedBlockAnnotationParserTests {
    @Fact
    func Repro_FromIssue_ParsesCleanly() {
        // The exact source quoted in the issue body. The signature uses
        // `sequence[int32]` so it exercises the same return-type shape the
        // dogfooded `Sequences.Range` helper expects.
        const source = `
package P

class Sequences {
    shared {
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        func Range(start int32, count int32) sequence[int32] {
            return nil
        }
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.NotNull(structDecl.SharedBlock)
        let method = Assert.Single(structDecl.SharedBlock!!.Methods)
        Assert.Equal("Range", method.Identifier.Text)
        let annotation = Assert.Single(method.Annotations)
        Assert.Equal("MethodImpl", annotation.GetNameText())
        Assert.True(annotation.HasArgumentList)
    }

    @Fact
    func StackedAnnotations_OnSharedMethod_AreAttached() {
        const source = `
package P

class Native {
    shared {
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        @DllImport("libfoo")
        func Bar(x int32) int32 {
            return x
        }
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let method = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().SharedBlock!!.Methods.Single()
        Assert.Equal("Bar", method.Identifier.Text)
        Assert.Equal(2, method.Annotations.Length)
        Assert.Equal("MethodImpl", method.Annotations[0].GetNameText())
        Assert.Equal("DllImport", method.Annotations[1].GetNameText())
    }

    @Theory
    @InlineData("public")
    @InlineData("internal")
    @InlineData("private")
    func AnnotationFollowedByAccessibilityModifiedFunc_Parses(accessibility string) {
        // ADR-0085 / ADR-0090 / ADR-0053: visibility modifiers may precede the
        // method in a `shared { }` block; the annotation must apply to the
        // resulting method (not to a phantom field).
        let source = (`
package P

class Sample {
    shared {
        @Obsolete
        ` + "$accessibility" + ` func Run() {
        }
    }
}
`)
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let method = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().SharedBlock!!.Methods.Single()
        Assert.Equal("Run", method.Identifier.Text)
        Assert.NotNull(method.AccessibilityModifier)
        Assert.Equal(accessibility, method.AccessibilityModifier!!.Text)
        let annotation = Assert.Single(method.Annotations)
        Assert.Equal("Obsolete", annotation.GetNameText())
    }

    @Fact
    func AnnotationOnSharedField_IsAttached() {
        const source = `
package P

class Config {
    shared {
        @Obsolete
        var Threshold int32 = 0
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let field = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().SharedBlock!!.Fields.Single()
        Assert.Equal("Threshold", field.Identifier.Text)
        let annotation = Assert.Single(field.Annotations)
        Assert.Equal("Obsolete", annotation.GetNameText())
    }

    @Fact
    func AnnotationOnSharedProperty_IsAttached() {
        const source = `
package P

class Config {
    shared {
        @Obsolete
        prop Name string
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().SharedBlock!!.Properties.Single()
        Assert.Equal("Name", property.Identifier.Text)
        let annotation = Assert.Single(property.Annotations)
        Assert.Equal("Obsolete", annotation.GetNameText())
    }

    @Fact
    func AnnotationFollowedByNonMemberToken_StillReportsParserDiagnostic() {
        // Negative: after consuming `@Obsolete`, the next token (`42`) is not
        // a legal start of any member; the field-declaration fallback must
        // surface its usual GS0288 (missing `var`/`let`) or similar error.
        const source = `
package P

class Sample {
    shared {
        @Obsolete
        42
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }
}
