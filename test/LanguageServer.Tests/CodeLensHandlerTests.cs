// <copyright file="CodeLensHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class CodeLensHandlerTests
{
    [Fact]
    public void ComputeLenses_ShowsReferenceCounts()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\nvar y = add(3, 4)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        Assert.Single(lenses);
        Assert.Equal("2 references", lenses[0].Command.Title);
    }

    [Fact]
    public void ComputeLenses_ShowsSingularReference()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        Assert.Single(lenses);
        Assert.Equal("1 reference", lenses[0].Command.Title);
    }

    [Fact]
    public void ComputeLenses_ShowsZeroReferences()
    {
        const string source = "func unused(a int32) int32 { return a }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        Assert.Single(lenses);
        Assert.Equal("0 references", lenses[0].Command.Title);
    }

    [Fact]
    public void ComputeLenses_MultipleFunctions()
    {
        const string source = "func a() int32 { return 1 }\nfunc b() int32 { return a() }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var lenses = CodeLensComputer.ComputeLenses(content);

        Assert.Equal(2, lenses.Count);
    }
}
