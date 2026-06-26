// <copyright file="Issue1202UnsafeClassModifierParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0122 / issue #1202: the <c>unsafe</c> class modifier must compose with
/// the other aggregate modifiers (<c>open</c>/<c>sealed</c>/visibility) in any
/// order. Previously only a SOLE leading <c>unsafe class</c> parsed; combining
/// it with <c>open</c> tripped the statement parser (GS0285/GS0125) and
/// aborted the declaration. These tests pin that <c>unsafe</c> is a first-class
/// member of the class modifier set.
/// </summary>
public class Issue1202UnsafeClassModifierParserTests
{
    [Fact]
    public void UnsafeOpenClass_Parses_WithoutDiagnostics()
    {
        const string source = "package p\nunsafe open class C { private var pBuffer *void }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void OpenUnsafeClass_Parses_WithoutDiagnostics()
    {
        const string source = "package p\nopen unsafe class C { private var pBuffer *void }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void UnsafeClass_SoleModifier_StillParses()
    {
        const string source = "package p\nunsafe class C { private var pBuffer *void }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Theory]
    [InlineData("package p\nunsafe open class C { }\n")]
    [InlineData("package p\nopen unsafe class C { }\n")]
    [InlineData("package p\npublic unsafe open class C { }\n")]
    [InlineData("package p\nunsafe sealed class C { }\n")]
    [InlineData("package p\nsealed unsafe class C { }\n")]
    public void UnsafeComposesWithClassModifiers_MarksNodeUnsafe(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var classDecl = root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(classDecl.IsUnsafe);
    }

    [Fact]
    public void UnsafeOnInterface_ReportsDiagnostic()
    {
        // `unsafe` is only valid on a class/struct head, not an interface.
        const string source = "package p\nunsafe interface I { }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }
}
