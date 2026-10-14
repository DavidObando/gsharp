// <copyright file="AnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Linq
import Xunit

/// Phase 1 of issue #141 / ADR-0047: lexer + parser support for Kotlin-style
/// annotation lead-ins on declarations and parameters. The binder and
/// emitter consume the parsed nodes in subsequent phases; these tests pin
/// only the surface syntax.
open class AnnotationParserTests {
    @Fact
    func Parses_Single_Annotation_On_Function_Without_Arguments() {
        const source = `
package P

@Serializable
func Foo() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let annotation = Assert.Single(fn.Annotations)
        Assert.Equal("Serializable", annotation.GetNameText())
        Assert.False(annotation.HasArgumentList)
        Assert.Null(annotation.Target)
    }

    @Fact
    func Parses_Annotation_With_Positional_And_Named_Arguments() {
        const source = `
package P

@AttributeUsage(AttributeTargets.Method, AllowMultiple: true)
func Foo() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let annotation = Assert.Single(fn.Annotations)
        Assert.Equal("AttributeUsage", annotation.GetNameText())
        Assert.True(annotation.HasArgumentList)
        Assert.Equal(2, annotation.Arguments.Count)
        Assert.IsType[NamedArgumentExpressionSyntax](annotation.Arguments[1])
    }

    @Fact
    func Parses_Dotted_Annotation_Name() {
        const source = `
package P

@System.Diagnostics.Conditional("DEBUG")
func Trace() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let annotation = Assert.Single(fn.Annotations)
        Assert.Equal("System.Diagnostics.Conditional", annotation.GetNameText())
        Assert.Equal(3, annotation.NameSegments.Length)
        Assert.Equal(2, annotation.DotTokens.Length)
    }

    @Fact
    func Parses_Multiple_Stacked_Annotations() {
        const source = `
package P

@Obsolete("use Bar")
@Conditional("DEBUG")
func Foo() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Equal(2, fn.Annotations.Length)
        Assert.Equal("Obsolete", fn.Annotations[0].GetNameText())
        Assert.Equal("Conditional", fn.Annotations[1].GetNameText())
    }

    @Theory
    @InlineData("field")
    @InlineData("param")
    @InlineData("return")
    @InlineData("type")
    @InlineData("method")
    @InlineData("property")
    @InlineData("event")
    @InlineData("genericparam")
    func Parses_All_Canonical_Use_Site_Targets(kind string) {
        let source = (`
package P

@` + "$kind" + `:Foo
func F() {
}
`)
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let annotation = Assert.Single(fn.Annotations)
        Assert.NotNull(annotation.Target)
        Assert.Equal(kind, annotation.Target!!.KindIdentifier.Text)
        Assert.Equal("Foo", annotation.GetNameText())
    }

    @Fact
    func Reports_Diagnostic_For_Unknown_Use_Site_Target() {
        const source = `
package P

@receiver:Foo
func F() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0197")
    }

    /// Issue #1929/#1953: unlike every other use-site target, `assembly:`
    /// is consumed by the parser at file scope (between `import`s and
    /// the first member) rather than attaching to the next declaration — it
    /// is the producer-side friend-assembly opt-in surface
    /// (`@assembly:InternalsVisibleTo("...")`), not a per-declaration
    /// custom attribute.
    @Fact
    func Assembly_Target_Annotation_Attaches_At_File_Scope_Not_To_Next_Member() {
        const source = `
package P

@assembly:InternalsVisibleTo("Foo.Tests")
func F() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let annotation = Assert.Single(tree.Root.AssemblyAttributes)
        Assert.NotNull(annotation.Target)
        Assert.Equal("assembly", annotation.Target!!.KindIdentifier.Text)
        Assert.Equal("InternalsVisibleTo", annotation.GetNameText())
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Empty(fn.Annotations)
    }

    @Fact
    func Module_Target_Annotation_Attaches_At_File_Scope_Not_To_Next_Member() {
        const source = `
package P

@module:System.CLSCompliantAttribute(true)
func F() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let annotation = Assert.Single(tree.Root.ModuleAttributes)
        Assert.NotNull(annotation.Target)
        Assert.Equal("module", annotation.Target!!.KindIdentifier.Text)
        Assert.Equal("System.CLSCompliantAttribute", annotation.GetNameText())
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Empty(fn.Annotations)
    }

    @Fact
    func File_Target_Annotations_AppearOnce_InSourceOrder_InChildTraversal() {
        const source = `
@module:System.CLSCompliantAttribute(true)
@assembly:System.Reflection.AssemblyTitleAttribute("Oahu")
`
        let tree = SyntaxTree.Parse(source)
        let annotations = tree.Root.GetChildren().OfType[AnnotationSyntax]().ToArray()
        Assert.Equal(2, annotations.Length)
        Assert.Equal("module", annotations[0].Target!!.KindIdentifier.Text)
        Assert.Equal("assembly", annotations[1].Target!!.KindIdentifier.Text)
    }

    @Fact
    func Reports_Diagnostic_When_At_Is_Not_Followed_By_Name() {
        const source = `
package P

@ 123
func F() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0196")
    }

    @Fact
    func Parses_Annotation_On_Parameter() {
        const source = `
package P

func F(@NotNull x int32) {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let param = fn.Parameters.Single()
        let annotation = Assert.Single(param.Annotations)
        Assert.Equal("NotNull", annotation.GetNameText())
    }

    @Fact
    func Parses_Multiple_Annotations_On_Parameter_Including_Targeted() {
        const source = `
package P

func F(@param:NotNull @Cool("yes") x int32) {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let param = fn.Parameters.Single()
        Assert.Equal(2, param.Annotations.Length)
        Assert.Equal("param", param.Annotations[0].Target!!.KindIdentifier.Text)
        Assert.True(param.Annotations[1].HasArgumentList)
    }

    @Fact
    func Annotation_With_No_Arguments_Equivalent_To_Empty_Parens() {
        const source = `
package P

@Marker
@Marker()
func F() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Equal(2, fn.Annotations.Length)
        Assert.False(fn.Annotations[0].HasArgumentList)
        Assert.True(fn.Annotations[1].HasArgumentList)
        Assert.Empty(fn.Annotations[1].Arguments)
    }

    @Fact
    func Annotation_Then_Accessibility_Modifier_Then_Func() {
        const source = `
package P

@Marker
public func F() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Single(fn.Annotations)
        Assert.NotNull(fn.AccessibilityModifier)
        Assert.Equal("public", fn.AccessibilityModifier!!.Text)
    }

    @Fact
    func Annotation_Allowed_Before_Struct_Declaration() {
        const source = `
package P

@Serializable
struct Point {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        // `struct Point { }` lowers in the parser to a
        // StructDeclarationSyntax (not a TypeAliasDeclarationSyntax), but
        // either way the annotation must round-trip on the MemberSyntax base.
        let member = tree
            .Root
            .Members
            .OfType[MemberSyntax]()
            .Single((m MemberSyntax) -> m is StructDeclarationSyntax || m is TypeAliasDeclarationSyntax)
        Assert.Single(member.Annotations)
    }

    @Fact
    func Lexer_Produces_AtToken_For_At_Sign() {
        // Direct lexer check: `@` produces an AtToken with the expected text.
        let sourceText = SourceText.From("@")
        let tree = SyntaxTree.Parse(sourceText)
        let token = tree.Root.GetChildren().SelectMany(EnumerateTokens).First((t SyntaxToken) -> t.Text == "@")
        Assert.Equal(SyntaxKind.AtToken, token.Kind)
    }

    @Fact
    func Parses_Annotation_On_Top_Level_Variable_With_Accessibility() {
        // Issue #187: a `@`-led annotation precedes `public var` at top
        // level and lands on the underlying VariableDeclarationSyntax, not
        // on the wrapping GlobalStatementSyntax.
        const source = `
package P

@Obsolete("dead")
public var counter = 0
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let member = tree.Root.Members.OfType[GlobalStatementSyntax]().Single()
        let decl = Assert.IsType[VariableDeclarationSyntax](member.Statement)
        let annotation = Assert.Single(decl.Annotations)
        Assert.Equal("Obsolete", annotation.GetNameText())
        Assert.Empty(member.Annotations)
    }

    @Fact
    func Parses_Annotation_On_Top_Level_Variable_Without_Accessibility() {
        // Issue #187: same as above but with no accessibility modifier;
        // ParseGlobalStatement → ParseStatement path must still forward the
        // member-level annotations onto the VariableDeclarationSyntax.
        const source = `
package P

@Obsolete
let limit = 10
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let member = tree.Root.Members.OfType[GlobalStatementSyntax]().Single()
        let decl = Assert.IsType[VariableDeclarationSyntax](member.Statement)
        Assert.Single(decl.Annotations)
        Assert.Empty(member.Annotations)
    }

    @Fact
    func Parses_Annotation_On_Local_Variable_Declaration() {
        // Issue #187: locals accept the same `@` lead-in surface syntax.
        const source = `
package P

func Main() {
    @Obsolete("dead local")
    let x = 1
    _ = x
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let block = Assert.IsType[BlockStatementSyntax](fn.Body)
        let decl = block.Statements.OfType[VariableDeclarationSyntax]().Single()
        let annotation = Assert.Single(decl.Annotations)
        Assert.Equal("Obsolete", annotation.GetNameText())
    }

    @Fact
    func Reports_GS0206_On_Annotation_Before_Non_Variable_Statement() {
        // Issue #187: `@` before a non-variable statement reports GS0206.
        const source = `
package P

func Main() {
    @Obsolete
    return
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0206")
    }

    @Fact
    func Parses_Annotation_On_Enum_Member() {
        // Issue #188: each entry in an `enum { ... }` body accepts a leading
        // `@`-annotation list, which lands on EnumMemberSyntax.Annotations.
        const source = `
package P

enum Color {
    @Obsolete("retired")
    Red,
    Green,
    Blue,
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let enumDecl = tree.Root.Members.OfType[EnumDeclarationSyntax]().Single()
        let red = enumDecl.Members.Single((m EnumMemberSyntax) -> m.Identifier.Text == "Red")
        let green = enumDecl.Members.Single((m EnumMemberSyntax) -> m.Identifier.Text == "Green")
        let annotation = Assert.Single(red.Annotations)
        Assert.Equal("Obsolete", annotation.GetNameText())
        Assert.Empty(green.Annotations)
    }

    @Fact
    func Parses_Multiple_Annotations_On_Enum_Member() {
        // Stacked `@A @B Red` is parsed as one EnumMemberSyntax with two
        // annotations; only the entry the `@`-list leads gets the annotations.
        const source = `
package P

enum Color {
    @Obsolete
    @Serializable
    Red,
    Green,
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let enumDecl = tree.Root.Members.OfType[EnumDeclarationSyntax]().Single()
        let red = enumDecl.Members.Single((m EnumMemberSyntax) -> m.Identifier.Text == "Red")
        let green = enumDecl.Members.Single((m EnumMemberSyntax) -> m.Identifier.Text == "Green")
        Assert.Equal(2, red.Annotations.Length)
        Assert.Empty(green.Annotations)
    }

    @Fact
    func Parses_Annotation_On_Struct_Field() {
        // Issue #186: each field declaration inside a `struct { ... }` body
        // accepts a leading `@`-annotation list, which lands on
        // FieldDeclarationSyntax.Annotations.
        const source = `
package P

data struct Point {
    @Obsolete("retired")
    var X int32
    var Y int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let x = structDecl.Fields.Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "X")
        let y = structDecl.Fields.Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "Y")
        let annotation = Assert.Single(x.Annotations)
        Assert.Equal("Obsolete", annotation.GetNameText())
        Assert.Empty(y.Annotations)
    }

    @Fact
    func Parses_Multiple_Annotations_On_Struct_Field() {
        // Stacked `@A @B X int` is parsed as one FieldDeclarationSyntax with
        // two annotations; only the field the `@`-list leads gets them.
        const source = `
package P

struct Point {
    @Obsolete
    @Serializable
    var X int32
    var Y int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let x = structDecl.Fields.Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "X")
        let y = structDecl.Fields.Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "Y")
        Assert.Equal(2, x.Annotations.Length)
        Assert.Empty(y.Annotations)
    }

    @Fact
    func Parses_Annotation_On_Class_Field_With_Accessibility() {
        // Annotations precede the accessibility modifier; the parser
        // resolves them onto the FieldDeclarationSyntax for the field that
        // follows, not onto sibling fields.
        const source = `
package P

class Box {
    @Obsolete
    public var Value int32
    public var Other int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let classDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let value = classDecl.Fields.Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "Value")
        let other = classDecl.Fields.Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "Other")
        Assert.Single(value.Annotations)
        Assert.Empty(other.Annotations)
    }

    shared {
        private func EnumerateTokens(node SyntaxNode) sequence[SyntaxToken] {
            if node is SyntaxToken t {
                yield t
                yield break
            }
            for child in node.GetChildren() {
                for inner in EnumerateTokens(child) {
                    yield inner
                }
            }
        }
    }
}
