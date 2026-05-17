// <copyright file="DocumentContentServiceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class DocumentContentServiceTests
{
    private static DocumentContent MakeContent(string text)
    {
        var tree = SyntaxTree.Parse(text);
        return new DocumentContent(tree, new List<int>());
    }

    [Fact]
    public void AddOrUpdate_Then_TryGet_ReturnsContent()
    {
        var service = new DocumentContentService();
        var content = MakeContent("package P\n");

        service.AddOrUpdate("file:///a.gs", content);

        Assert.True(service.TryGet("file:///a.gs", out var got));
        Assert.Same(content, got);
    }

    [Fact]
    public void TryGet_Missing_ReturnsFalse()
    {
        var service = new DocumentContentService();
        Assert.False(service.TryGet("file:///missing.gs", out _));
    }

    [Fact]
    public void AddOrUpdate_Overwrites_Existing()
    {
        var service = new DocumentContentService();
        var c1 = MakeContent("package A\n");
        var c2 = MakeContent("package B\n");
        service.AddOrUpdate("file:///a.gs", c1);
        service.AddOrUpdate("file:///a.gs", c2);

        Assert.True(service.TryGet("file:///a.gs", out var got));
        Assert.Same(c2, got);
    }

    [Fact]
    public void TryRemove_RemovesEntry()
    {
        var service = new DocumentContentService();
        service.AddOrUpdate("file:///a.gs", MakeContent("package P\n"));

        Assert.True(service.TryRemove("file:///a.gs"));
        Assert.False(service.TryGet("file:///a.gs", out _));
    }
}

