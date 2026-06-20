// <copyright file="Issue894ConstructorHoverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LanguageServer.Tests;

using GSharp.LanguageServer;
using Xunit;

/// <summary>
/// Issue #894: hovering over a local variable, a constructor parameter, or a
/// class member referenced inside an <c>init(...)</c> constructor body must
/// produce the same hover result as the equivalent reference inside a normal
/// method body.
/// </summary>
public class Issue894ConstructorHoverTests
{
    [Fact]
    public void ComputeHover_LocalVariableInsideConstructorBody()
    {
        const string source =
            "package P\nclass Widget {\n    var Area int32\n    init(w int32, h int32) {\n        var product = w * h\n        Area = product\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "product", 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("(local variable) product int32", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ConstructorParameterInsideConstructorBody()
    {
        const string source =
            "package P\nclass Widget {\n    var Area int32\n    init(w int32, h int32) {\n        var product = w * h\n        Area = product\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "w", 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("(parameter) w int32", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ClassMemberInsideConstructorBody()
    {
        const string source =
            "package P\nclass Widget {\n    /// The computed area.\n    var Area int32\n    init(w int32, h int32) {\n        var product = w * h\n        Area = product\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Area", 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Area int32", value, System.StringComparison.Ordinal);
        Assert.Contains("The computed area.", value, System.StringComparison.Ordinal);
    }
}
