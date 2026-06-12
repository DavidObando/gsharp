// <copyright file="AnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Phase 1 of issue #141 / ADR-0047: lexer + parser support for Kotlin-style
/// annotation lead-ins on declarations and parameters. The binder and
/// emitter consume the parsed nodes in subsequent phases; these tests pin
/// only the surface syntax.
/// </summary>
public class AnnotationParserTests
{
    [Fact]
    public void Parses_Single_Annotation_On_Function_Without_Arguments()
    {
        const string source = @"
package P

@Serializable
func Foo() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var annotation = Assert.Single(fn.Annotations);
        Assert.Equal("Serializable", annotation.GetNameText());
        Assert.False(annotation.HasArgumentList);
        Assert.Null(annotation.Target);
    }

    [Fact]
    public void Parses_Annotation_With_Positional_And_Named_Arguments()
    {
        const string source = @"
package P

@AttributeUsage(AttributeTargets.Method, AllowMultiple: true)
func Foo() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var annotation = Assert.Single(fn.Annotations);
        Assert.Equal("AttributeUsage", annotation.GetNameText());
        Assert.True(annotation.HasArgumentList);
        Assert.Equal(2, annotation.Arguments.Count);
        Assert.IsType<NamedArgumentExpressionSyntax>(annotation.Arguments[1]);
    }

    [Fact]
    public void Parses_Dotted_Annotation_Name()
    {
        const string source = @"
package P

@System.Diagnostics.Conditional(""DEBUG"")
func Trace() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var annotation = Assert.Single(fn.Annotations);
        Assert.Equal("System.Diagnostics.Conditional", annotation.GetNameText());
        Assert.Equal(3, annotation.NameSegments.Length);
        Assert.Equal(2, annotation.DotTokens.Length);
    }

    [Fact]
    public void Parses_Multiple_Stacked_Annotations()
    {
        const string source = @"
package P

@Obsolete(""use Bar"")
@Conditional(""DEBUG"")
func Foo() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Equal(2, fn.Annotations.Length);
        Assert.Equal("Obsolete", fn.Annotations[0].GetNameText());
        Assert.Equal("Conditional", fn.Annotations[1].GetNameText());
    }

    [Theory]
    [InlineData("field")]
    [InlineData("param")]
    [InlineData("return")]
    [InlineData("type")]
    [InlineData("method")]
    [InlineData("property")]
    [InlineData("event")]
    [InlineData("module")]
    [InlineData("assembly")]
    [InlineData("genericparam")]
    public void Parses_All_Canonical_Use_Site_Targets(string kind)
    {
        var source = $@"
package P

@{kind}:Foo
func F() {{
}}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var annotation = Assert.Single(fn.Annotations);
        Assert.NotNull(annotation.Target);
        Assert.Equal(kind, annotation.Target.KindIdentifier.Text);
        Assert.Equal("Foo", annotation.GetNameText());
    }

    [Fact]
    public void Reports_Diagnostic_For_Unknown_Use_Site_Target()
    {
        const string source = @"
package P

@receiver:Foo
func F() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0197");
    }

    [Fact]
    public void Reports_Diagnostic_When_At_Is_Not_Followed_By_Name()
    {
        const string source = @"
package P

@ 123
func F() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0196");
    }

    [Fact]
    public void Parses_Annotation_On_Parameter()
    {
        const string source = @"
package P

func F(@NotNull x int32) {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var param = fn.Parameters.Single();
        var annotation = Assert.Single(param.Annotations);
        Assert.Equal("NotNull", annotation.GetNameText());
    }

    [Fact]
    public void Parses_Multiple_Annotations_On_Parameter_Including_Targeted()
    {
        const string source = @"
package P

func F(@param:NotNull @Cool(""yes"") x int32) {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var param = fn.Parameters.Single();
        Assert.Equal(2, param.Annotations.Length);
        Assert.Equal("param", param.Annotations[0].Target.KindIdentifier.Text);
        Assert.True(param.Annotations[1].HasArgumentList);
    }

    [Fact]
    public void Annotation_With_No_Arguments_Equivalent_To_Empty_Parens()
    {
        const string source = @"
package P

@Marker
@Marker()
func F() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Equal(2, fn.Annotations.Length);
        Assert.False(fn.Annotations[0].HasArgumentList);
        Assert.True(fn.Annotations[1].HasArgumentList);
        Assert.Empty(fn.Annotations[1].Arguments);
    }

    [Fact]
    public void Annotation_Then_Accessibility_Modifier_Then_Func()
    {
        const string source = @"
package P

@Marker
public func F() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Single(fn.Annotations);
        Assert.NotNull(fn.AccessibilityModifier);
        Assert.Equal("public", fn.AccessibilityModifier.Text);
    }

    [Fact]
    public void Annotation_Allowed_Before_Struct_Declaration()
    {
        const string source = @"
package P

@Serializable
struct Point {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        // `struct Point { }` lowers in the parser to a
        // StructDeclarationSyntax (not a TypeAliasDeclarationSyntax), but
        // either way the annotation must round-trip on the MemberSyntax base.
        var member = tree.Root.Members.OfType<MemberSyntax>().Single(m => m is StructDeclarationSyntax || m is TypeAliasDeclarationSyntax);
        Assert.Single(member.Annotations);
    }

    [Fact]
    public void Lexer_Produces_AtToken_For_At_Sign()
    {
        // Direct lexer check: `@` produces an AtToken with the expected text.
        var sourceText = GSharp.Core.CodeAnalysis.Text.SourceText.From("@");
        var tree = SyntaxTree.Parse(sourceText);
        var token = tree.Root.GetChildren().SelectMany(EnumerateTokens).First(t => t.Text == "@");
        Assert.Equal(SyntaxKind.AtToken, token.Kind);
    }

    [Fact]
    public void Parses_Annotation_On_Top_Level_Variable_With_Accessibility()
    {
        // Issue #187: a `@`-led annotation precedes `public var` at top
        // level and lands on the underlying VariableDeclarationSyntax, not
        // on the wrapping GlobalStatementSyntax.
        const string source = @"
package P

@Obsolete(""dead"")
public var counter = 0
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var member = tree.Root.Members.OfType<GlobalStatementSyntax>().Single();
        var decl = Assert.IsType<VariableDeclarationSyntax>(member.Statement);
        var annotation = Assert.Single(decl.Annotations);
        Assert.Equal("Obsolete", annotation.GetNameText());
        Assert.Empty(member.Annotations);
    }

    [Fact]
    public void Parses_Annotation_On_Top_Level_Variable_Without_Accessibility()
    {
        // Issue #187: same as above but with no accessibility modifier;
        // ParseGlobalStatement → ParseStatement path must still forward the
        // member-level annotations onto the VariableDeclarationSyntax.
        const string source = @"
package P

@Obsolete
let limit = 10
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var member = tree.Root.Members.OfType<GlobalStatementSyntax>().Single();
        var decl = Assert.IsType<VariableDeclarationSyntax>(member.Statement);
        Assert.Single(decl.Annotations);
        Assert.Empty(member.Annotations);
    }

    [Fact]
    public void Parses_Annotation_On_Local_Variable_Declaration()
    {
        // Issue #187: locals accept the same `@` lead-in surface syntax.
        const string source = @"
package P

func Main() {
    @Obsolete(""dead local"")
    let x = 1
    _ = x
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var block = Assert.IsType<BlockStatementSyntax>(fn.Body);
        var decl = block.Statements.OfType<VariableDeclarationSyntax>().Single();
        var annotation = Assert.Single(decl.Annotations);
        Assert.Equal("Obsolete", annotation.GetNameText());
    }

    [Fact]
    public void Reports_GS0206_On_Annotation_Before_Non_Variable_Statement()
    {
        // Issue #187: `@` before a non-variable statement reports GS0206.
        const string source = @"
package P

func Main() {
    @Obsolete
    return
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0206");
    }

    [Fact]
    public void Parses_Annotation_On_Enum_Member()
    {
        // Issue #188: each entry in an `enum { ... }` body accepts a leading
        // `@`-annotation list, which lands on EnumMemberSyntax.Annotations.
        const string source = @"
package P

enum Color {
    @Obsolete(""retired"")
    Red,
    Green,
    Blue,
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var enumDecl = tree.Root.Members.OfType<EnumDeclarationSyntax>().Single();
        var red = enumDecl.Members.Single(m => m.Identifier.Text == "Red");
        var green = enumDecl.Members.Single(m => m.Identifier.Text == "Green");

        var annotation = Assert.Single(red.Annotations);
        Assert.Equal("Obsolete", annotation.GetNameText());
        Assert.Empty(green.Annotations);
    }

    [Fact]
    public void Parses_Multiple_Annotations_On_Enum_Member()
    {
        // Stacked `@A @B Red` is parsed as one EnumMemberSyntax with two
        // annotations; only the entry the `@`-list leads gets the annotations.
        const string source = @"
package P

enum Color {
    @Obsolete
    @Serializable
    Red,
    Green,
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var enumDecl = tree.Root.Members.OfType<EnumDeclarationSyntax>().Single();
        var red = enumDecl.Members.Single(m => m.Identifier.Text == "Red");
        var green = enumDecl.Members.Single(m => m.Identifier.Text == "Green");

        Assert.Equal(2, red.Annotations.Length);
        Assert.Empty(green.Annotations);
    }

    [Fact]
    public void Parses_Annotation_On_Struct_Field()
    {
        // Issue #186: each field declaration inside a `struct { ... }` body
        // accepts a leading `@`-annotation list, which lands on
        // FieldDeclarationSyntax.Annotations.
        const string source = @"
package P

data struct Point {
    @Obsolete(""retired"")
    var X int32
    var Y int32
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var x = structDecl.Fields.Single(f => f.Identifier.Text == "X");
        var y = structDecl.Fields.Single(f => f.Identifier.Text == "Y");

        var annotation = Assert.Single(x.Annotations);
        Assert.Equal("Obsolete", annotation.GetNameText());
        Assert.Empty(y.Annotations);
    }

    [Fact]
    public void Parses_Multiple_Annotations_On_Struct_Field()
    {
        // Stacked `@A @B X int` is parsed as one FieldDeclarationSyntax with
        // two annotations; only the field the `@`-list leads gets them.
        const string source = @"
package P

struct Point {
    @Obsolete
    @Serializable
    var X int32
    var Y int32
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var x = structDecl.Fields.Single(f => f.Identifier.Text == "X");
        var y = structDecl.Fields.Single(f => f.Identifier.Text == "Y");

        Assert.Equal(2, x.Annotations.Length);
        Assert.Empty(y.Annotations);
    }

    [Fact]
    public void Parses_Annotation_On_Class_Field_With_Accessibility()
    {
        // Annotations precede the accessibility modifier; the parser
        // resolves them onto the FieldDeclarationSyntax for the field that
        // follows, not onto sibling fields.
        const string source = @"
package P

class Box {
    @Obsolete
    public var Value int32
    public var Other int32
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var classDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var value = classDecl.Fields.Single(f => f.Identifier.Text == "Value");
        var other = classDecl.Fields.Single(f => f.Identifier.Text == "Other");

        Assert.Single(value.Annotations);
        Assert.Empty(other.Annotations);
    }

    private static System.Collections.Generic.IEnumerable<SyntaxToken> EnumerateTokens(SyntaxNode node)
    {
        if (node is SyntaxToken t)
        {
            yield return t;
            yield break;
        }

        foreach (var child in node.GetChildren())
        {
            foreach (var inner in EnumerateTokens(child))
            {
                yield return inner;
            }
        }
    }
}
