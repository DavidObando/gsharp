// <copyright file="ParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public class ParserTests
{
    [Fact]
    public void Parses_HelloWorld_Sample_Without_Diagnostics()
    {
        const string source = @"
package HelloWorld

import System

Console.WriteLine(""Hello, world!"")
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.NotNull(tree.Root);
        var pkg = tree.Root.Members.OfType<PackageSyntax>().Single();
        Assert.Equal("HelloWorld", pkg.Identifiers.Single().Text);
    }

    [Fact]
    public void Parses_Function_Declaration()
    {
        const string source = @"
package P

func Main() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Equal("Main", fn.Identifier.Text);
    }

    [Fact]
    public void Reports_Diagnostic_On_Missing_Brace()
    {
        const string source = @"
package P

func Main() {
";
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void Tolerates_Missing_Package()
    {
        const string source = "func Main() {}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.NotNull(tree.Root);
    }
}
