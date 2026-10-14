// <copyright file="Issue856QuotePathsWithSpacesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import GSharp.Compiler
import Gsharp.NET.Sdk.Tools
import Xunit

/// Regression coverage for issue #856: on Windows, when `dotnet` is
/// installed under `C:\Program Files\dotnet\...`, reference paths the
/// BuildTask writes into the gsc response file embed a literal space. The
/// response-file tokenizer in `gsc` splits on unquoted whitespace, so
/// arguments with embedded spaces must be wrapped in double quotes by the
/// BuildTask. These tests pin both halves of that contract: the
/// (cref:BuildTask.QuoteIfNeeded(string)) producer-side helper and the
/// (cref:Program.TokenizeResponseFileLine(string)) consumer-side parser.
open class Issue856QuotePathsWithSpacesTests {
    @Fact
    func QuoteIfNeeded_NoSpace_LeavesValueUnchanged() {
        Assert.Equal("/r:C:\\NoSpaces\\foo.dll", BuildTask.QuoteIfNeeded("/r:C:\\NoSpaces\\foo.dll"))
    }

    @Fact
    func QuoteIfNeeded_WithSpace_WrapsInQuotes() {
        Assert.Equal(
            "\"/r:C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\Microsoft.CSharp.dll\"",
            BuildTask.QuoteIfNeeded(
                "/r:C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\Microsoft.CSharp.dll"
            )
        )
    }

    @Fact
    func QuoteIfNeeded_NullOrEmpty_PassesThrough() {
        Assert.Null(BuildTask.QuoteIfNeeded(nil))
        Assert.Equal(string.Empty, BuildTask.QuoteIfNeeded(string.Empty))
    }

    @Fact
    func QuotedReferencePath_RoundTrips_Through_ResponseFileTokenizer() {
        const raw = "/r:C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\Microsoft.CSharp.dll"
        let line = BuildTask.QuoteIfNeeded(raw)
        let tokens = Program.TokenizeResponseFileLine(line)
        let token = Assert.Single(tokens)
        Assert.Equal(raw, token)
    }

    @Fact
    func QuotedSourcePath_RoundTrips_Through_ResponseFileTokenizer() {
        const raw = "C:\\Users\\Alice With Space\\src\\main.gs"
        let line = BuildTask.QuoteIfNeeded(raw)
        let tokens = Program.TokenizeResponseFileLine(line)
        let token = Assert.Single(tokens)
        Assert.Equal(raw, token)
    }

    @Fact
    func UnquotedPathWithSpace_GetsSplit_DemonstratingTheBug() {
        // This is the original #856 failure mode: without quoting, the path
        // is broken into two tokens at the embedded space.
        const raw = "/r:C:\\Program Files\\dotnet\\Microsoft.CSharp.dll"
        let tokens = Program.TokenizeResponseFileLine(raw)
        Assert.Equal(2, tokens.Count)
    }
}
