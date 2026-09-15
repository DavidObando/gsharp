// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class Issue4219GenericLocalRecursionTests
{
    private const string Source = """
        func Run() int32 {
            let first[T] = func(value T, depth int32) int32 {
                return second(value, depth)
            }
            let second[U] = func(value U, depth int32) int32 {
                if depth == 0 { return 42 }
                return first(value, depth - 1)
            }
            return first("x", 2)
        }
        """;

    [Fact]
    public void ForwardCall_NavigatesToGenericLocalDeclaration()
    {
        var content = LanguageServerTestHelpers.Content(Source);
        var uri = DocumentUri.From("file:///generic-group.gs");
        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(Source, "second"));
        Assert.NotNull(location);
        Assert.Equal(uri, location.Uri);
        var expected = LanguageServerTestHelpers.PositionOf(Source, "second", 1);
        Assert.Equal(expected.Line, location.Range.Start.Line);
        Assert.Equal(expected.Character, location.Range.Start.Character);
    }

    [Theory]
    [InlineData("second(")]
    [InlineData("second[T](")]
    public void ForwardCall_HasSignatureHelpAndHover(string call)
    {
        var source = Source.Replace("second(", call, StringComparison.Ordinal);
        var content = LanguageServerTestHelpers.Content(source);
        var position = LanguageServerTestHelpers.PositionOf(source, call);
        var help = SignatureHelpComputer.ComputeSignatureHelp(content, new Position(position.Line, position.Character + call.Length));
        Assert.NotNull(help);
        Assert.Contains("second", Assert.Single(help.Signatures).Label, StringComparison.Ordinal);
        Assert.Equal(2, help.Signatures.First().Parameters.Count());
        var hover = HoverComputer.ComputeHover(content, position);
        Assert.NotNull(hover);
        Assert.Contains("second", hover.Contents.ToString(), StringComparison.Ordinal);
    }
}
