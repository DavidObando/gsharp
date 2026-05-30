// <copyright file="CodeActionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer.Tests;

public class CodeActionHandlerTests
{
    [Fact]
    public void ComputeCodeActions_OffersSortImports()
    {
        const string source = "import Zeta\nimport Alpha\nfunc F() {}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///actions.gs");

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, new Range(new Position(0, 0), new Position(0, 0))).ToList();

        var action = Assert.Single(actions).CodeAction;
        Assert.Equal("Sort imports", action.Title);
        Assert.Contains("import Alpha", action.Edit.Changes[uri].Single().NewText, System.StringComparison.Ordinal);
    }
}
