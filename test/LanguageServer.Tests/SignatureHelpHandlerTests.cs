// <copyright file="SignatureHelpHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class SignatureHelpHandlerTests
{
    [Fact]
    public void ComputeSignatureHelp_AtOpenParen_ShowsFirstParameter()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nlet r = add(\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Position just after the opening paren
        var position = LanguageServerTestHelpers.PositionOf(source, "add(");
        position = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Position(position.Line, position.Character + 4);

        var help = SignatureHelpComputer.ComputeSignatureHelp(content, position);

        Assert.NotNull(help);
        Assert.Single(help.Signatures);
        Assert.Equal(0, help.ActiveParameter);
        Assert.Contains("add", help.Signatures.First().Label, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeSignatureHelp_AfterComma_ShowsSecondParameter()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nlet r = add(1,\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Position just after the comma
        var position = LanguageServerTestHelpers.PositionOf(source, "1,");
        position = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Position(position.Line, position.Character + 2);

        var help = SignatureHelpComputer.ComputeSignatureHelp(content, position);

        Assert.NotNull(help);
        Assert.Equal(1, help.ActiveParameter);
    }

    [Fact]
    public void ComputeSignatureHelp_OutsideCall_ReturnsNull()
    {
        const string source = "let x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);

        var help = SignatureHelpComputer.ComputeSignatureHelp(content, LanguageServerTestHelpers.PositionOf(source, "42"));

        Assert.Null(help);
    }
}
