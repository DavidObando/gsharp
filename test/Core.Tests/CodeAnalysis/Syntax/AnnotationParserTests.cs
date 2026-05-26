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

@AttributeUsage(AttributeTargets.Method, AllowMultiple = true)
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

func F(@NotNull x int) {
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

func F(@param:NotNull @Cool(""yes"") x int) {
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
type Point struct {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        // `type Point struct { }` lowers in the parser to a
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
