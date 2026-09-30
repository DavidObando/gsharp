// <copyright file="DocumentContentServiceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
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
        Assert.Same(content.SyntaxTree, got.SyntaxTree);
    }

    [Fact]
    public void TryGet_Missing_ReturnsFalse()
    {
        var service = new DocumentContentService();
        Assert.False(service.TryGet("file:///missing.gs", out var content));
        Assert.Null(content);
    }

    [Fact]
    public void TryGet_Contract_NarrowsOnlyOnSuccess()
    {
        var method = typeof(DocumentContentService).GetMethod(nameof(DocumentContentService.TryGet));
        AssertNotNullOnlyOnSuccess(method);
    }

    [Fact]
    public void LspTryGet_Contract_NarrowsOnlyOnSuccess()
    {
        var method = typeof(LspServer).GetMethod(
            "TryGet",
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            new[] { typeof(TextDocumentIdentifier), typeof(DocumentContent).MakeByRefType() },
            modifiers: null);

        AssertNotNullOnlyOnSuccess(method);
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

    private static void AssertNotNullOnlyOnSuccess(MethodInfo? method)
    {
        Assert.NotNull(method);
        var parameter = method.GetParameters()[1];
        var contract = Assert.Single(parameter.GetCustomAttributes<NotNullWhenAttribute>());

        Assert.True(contract.ReturnValue);
        Assert.Equal(
            NullabilityState.Nullable,
            new NullabilityInfoContext().Create(parameter).WriteState);
    }
}
