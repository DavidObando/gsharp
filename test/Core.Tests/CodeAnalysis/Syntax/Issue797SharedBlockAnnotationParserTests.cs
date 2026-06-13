// <copyright file="Issue797SharedBlockAnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #797: parser support for Kotlin-style <c>@Foo</c> annotations
/// (ADR-0047 §3) on members declared inside a <c>shared { … }</c> block
/// (ADR-0053). The top-level / instance-member surface accepts <c>@Foo</c>
/// lead-ins on every member kind; before #797 the shared-block parser
/// treated a leading <c>@</c> as the start of a field declaration and
/// rejected programs like
/// <c>shared { @MethodImpl(...) func Range(...) sequence[int32] { ... } }</c>.
/// </summary>
public class Issue797SharedBlockAnnotationParserTests
{
    [Fact]
    public void Repro_FromIssue_ParsesCleanly()
    {
        // The exact source quoted in the issue body. The signature uses
        // `sequence[int32]` so it exercises the same return-type shape the
        // dogfooded `Sequences.Range` helper expects.
        const string source = @"
package P

class Sequences {
    shared {
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        func Range(start int32, count int32) sequence[int32] {
            return nil
        }
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.NotNull(structDecl.SharedBlock);
        var method = Assert.Single(structDecl.SharedBlock.Methods);
        Assert.Equal("Range", method.Identifier.Text);
        var annotation = Assert.Single(method.Annotations);
        Assert.Equal("MethodImpl", annotation.GetNameText());
        Assert.True(annotation.HasArgumentList);
    }

    [Fact]
    public void StackedAnnotations_OnSharedMethod_AreAttached()
    {
        const string source = @"
package P

class Native {
    shared {
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        @DllImport(""libfoo"")
        func Bar(x int32) int32 {
            return x
        }
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var method = tree.Root.Members
            .OfType<StructDeclarationSyntax>().Single()
            .SharedBlock!.Methods.Single();
        Assert.Equal("Bar", method.Identifier.Text);
        Assert.Equal(2, method.Annotations.Length);
        Assert.Equal("MethodImpl", method.Annotations[0].GetNameText());
        Assert.Equal("DllImport", method.Annotations[1].GetNameText());
    }

    [Theory]
    [InlineData("public")]
    [InlineData("internal")]
    [InlineData("private")]
    public void AnnotationFollowedByAccessibilityModifiedFunc_Parses(string accessibility)
    {
        // ADR-0085 / ADR-0090 / ADR-0053: visibility modifiers may precede the
        // method in a `shared { }` block; the annotation must apply to the
        // resulting method (not to a phantom field).
        var source = $@"
package P

class Sample {{
    shared {{
        @Obsolete
        {accessibility} func Run() {{
        }}
    }}
}}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var method = tree.Root.Members
            .OfType<StructDeclarationSyntax>().Single()
            .SharedBlock!.Methods.Single();
        Assert.Equal("Run", method.Identifier.Text);
        Assert.NotNull(method.AccessibilityModifier);
        Assert.Equal(accessibility, method.AccessibilityModifier.Text);
        var annotation = Assert.Single(method.Annotations);
        Assert.Equal("Obsolete", annotation.GetNameText());
    }

    [Fact]
    public void AnnotationOnSharedField_IsAttached()
    {
        const string source = @"
package P

class Config {
    shared {
        @Obsolete
        var Threshold int32 = 0
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var field = tree.Root.Members
            .OfType<StructDeclarationSyntax>().Single()
            .SharedBlock!.Fields.Single();
        Assert.Equal("Threshold", field.Identifier.Text);
        var annotation = Assert.Single(field.Annotations);
        Assert.Equal("Obsolete", annotation.GetNameText());
    }

    [Fact]
    public void AnnotationOnSharedProperty_IsAttached()
    {
        const string source = @"
package P

class Config {
    shared {
        @Obsolete
        prop Name string
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var property = tree.Root.Members
            .OfType<StructDeclarationSyntax>().Single()
            .SharedBlock!.Properties.Single();
        Assert.Equal("Name", property.Identifier.Text);
        var annotation = Assert.Single(property.Annotations);
        Assert.Equal("Obsolete", annotation.GetNameText());
    }

    [Fact]
    public void AnnotationFollowedByNonMemberToken_StillReportsParserDiagnostic()
    {
        // Negative: after consuming `@Obsolete`, the next token (`42`) is not
        // a legal start of any member; the field-declaration fallback must
        // surface its usual GS0288 (missing `var`/`let`) or similar error.
        const string source = @"
package P

class Sample {
    shared {
        @Obsolete
        42
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }
}
