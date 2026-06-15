// <copyright file="Issue856QuotePathsWithSpacesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Gsharp.NET.Sdk.Tools;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Regression coverage for issue #856: on Windows, when <c>dotnet</c> is
/// installed under <c>C:\Program Files\dotnet\...</c>, reference paths the
/// BuildTask writes into the gsc response file embed a literal space. The
/// response-file tokenizer in <c>gsc</c> splits on unquoted whitespace, so
/// arguments with embedded spaces must be wrapped in double quotes by the
/// BuildTask. These tests pin both halves of that contract: the
/// <see cref="BuildTask.QuoteIfNeeded(string)"/> producer-side helper and the
/// <see cref="Program.TokenizeResponseFileLine(string)"/> consumer-side parser.
/// </summary>
public class Issue856QuotePathsWithSpacesTests
{
    [Fact]
    public void QuoteIfNeeded_NoSpace_LeavesValueUnchanged()
    {
        Assert.Equal("/r:C:\\NoSpaces\\foo.dll", BuildTask.QuoteIfNeeded("/r:C:\\NoSpaces\\foo.dll"));
    }

    [Fact]
    public void QuoteIfNeeded_WithSpace_WrapsInQuotes()
    {
        Assert.Equal(
            "\"/r:C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\Microsoft.CSharp.dll\"",
            BuildTask.QuoteIfNeeded("/r:C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\Microsoft.CSharp.dll"));
    }

    [Fact]
    public void QuoteIfNeeded_NullOrEmpty_PassesThrough()
    {
        Assert.Null(BuildTask.QuoteIfNeeded(null));
        Assert.Equal(string.Empty, BuildTask.QuoteIfNeeded(string.Empty));
    }

    [Fact]
    public void QuotedReferencePath_RoundTrips_Through_ResponseFileTokenizer()
    {
        const string raw = "/r:C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\Microsoft.CSharp.dll";

        var line = BuildTask.QuoteIfNeeded(raw);
        var tokens = Program.TokenizeResponseFileLine(line);

        var token = Assert.Single(tokens);
        Assert.Equal(raw, token);
    }

    [Fact]
    public void QuotedSourcePath_RoundTrips_Through_ResponseFileTokenizer()
    {
        const string raw = "C:\\Users\\Alice With Space\\src\\main.gs";

        var line = BuildTask.QuoteIfNeeded(raw);
        var tokens = Program.TokenizeResponseFileLine(line);

        var token = Assert.Single(tokens);
        Assert.Equal(raw, token);
    }

    [Fact]
    public void UnquotedPathWithSpace_GetsSplit_DemonstratingTheBug()
    {
        // This is the original #856 failure mode: without quoting, the path
        // is broken into two tokens at the embedded space.
        const string raw = "/r:C:\\Program Files\\dotnet\\Microsoft.CSharp.dll";
        var tokens = Program.TokenizeResponseFileLine(raw);
        Assert.Equal(2, tokens.Count);
    }
}
