// <copyright file="TestDiscoveryComputerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class TestDiscoveryComputerTests
{
    [Fact]
    public void ComputeTests_DiscoversTopLevelTestFunction()
    {
        const string source = "@Test\nfunc RunsThing() {\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content);

        var item = Assert.Single(tests);
        Assert.Equal("RunsThing", item.Label);
        Assert.Equal("RunsThing", item.Filter);
        Assert.Equal("file:///t.gs", item.Uri);
        Assert.Null(item.Children);
    }

    [Fact]
    public void ComputeTests_DiscoversClassMethodsWithQualifiedFilter()
    {
        const string source = "type MyTests class {\n  @Fact\n  func PassesA() {\n  }\n\n  @Fact\n  func PassesB() {\n  }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content);

        var group = Assert.Single(tests);
        Assert.Equal("MyTests", group.Label);
        Assert.Null(group.Filter);
        Assert.NotNull(group.Children);
        Assert.Equal(2, group.Children.Length);
        Assert.Equal(new[] { "MyTests.PassesA", "MyTests.PassesB" }, group.Children.Select(c => c.Filter).ToArray());
    }

    [Fact]
    public void ComputeTests_IgnoresFunctionsWithoutTestAttribute()
    {
        const string source = "func plainHelper() {\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content);

        Assert.Empty(tests);
    }

    [Fact]
    public void ComputeTests_RecognizesAttributeSuffix()
    {
        const string source = "@FactAttribute\nfunc Suffixed() {\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content);

        Assert.Single(tests);
    }
}
