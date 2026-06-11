// <copyright file="ParserTopLevelOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0066 deferred decision D5: within a single <c>.gs</c> file, top-level
/// statements must form a single contiguous block — they may all sit at the
/// top of the file (the C#-style idiom), all sit at the bottom (the Go-style
/// idiom most G# samples follow), or be the only members, but they cannot
/// be interleaved with type / function declarations. Interleaved layouts
/// are reported by the parser as <c>GS0286</c>.
/// </summary>
public class ParserTopLevelOrderingTests
{
    private const string Gs0286 = "GS0286";

    [Fact]
    public void All_TopLevel_Statements_No_Declarations_Reports_Nothing()
    {
        var tree = SyntaxTree.Parse(SourceText.From("package P\nvar x = 1\nvar y = 2\n"));

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == Gs0286);
    }

    [Fact]
    public void TopLevel_Block_Then_Declarations_Reports_Nothing()
    {
        // C#-style: all TLS first, then declarations.
        var tree = SyntaxTree.Parse(SourceText.From(
            "package P\nvar x = 1\nfunc Helper() {\n}\n"));

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == Gs0286);
    }

    [Fact]
    public void Declarations_Then_TopLevel_Block_Reports_Nothing()
    {
        // Go-style: all declarations first, trailing TLS block. This is the
        // prevailing G# idiom across ~488 samples + test fixtures, so the
        // contiguous rule must allow it.
        var tree = SyntaxTree.Parse(SourceText.From(
            "package P\nfunc Helper() {\n}\nvar x = 1\nvar y = 2\n"));

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == Gs0286);
    }

    [Fact]
    public void TopLevel_Then_Declaration_Then_TopLevel_Reports_GS0286_On_Second_Block()
    {
        // TLS interleaved with a declaration — the truly confusing layout
        // that the contiguous rule exists to catch.
        var tree = SyntaxTree.Parse(SourceText.From(
            "package P\nvar x = 1\nfunc Helper() {\n}\nvar y = 2\n"));

        var diagnostic = Assert.Single(tree.Diagnostics, d => d.Id == Gs0286);
        Assert.Contains("var y = 2", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void Two_Trailing_TopLevel_Statements_After_Multiple_Declarations_Are_Treated_As_One_Block()
    {
        // Companion to Declarations_Then_TopLevel_Block_Reports_Nothing —
        // the trailing TLS block can have any number of statements; only
        // *interleaving* triggers GS0286.
        var tree = SyntaxTree.Parse(SourceText.From(
            "package P\nfunc A() {\n}\nfunc B() {\n}\nvar x = 1\nvar y = 2\n"));

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == Gs0286);
    }

    [Fact]
    public void Multiple_Interleaved_TopLevel_Statements_Each_Report_GS0286()
    {
        // TLS, decl, TLS, decl, TLS — three TLS, two interleaving decls.
        // The first TLS is allowed (no prior decl-after-TLS), the second
        // and third each violate contiguity.
        var tree = SyntaxTree.Parse(SourceText.From(
            "package P\nvar a = 1\nfunc F() {\n}\nvar b = 2\nfunc G() {\n}\nvar c = 3\n"));

        Assert.Equal(2, tree.Diagnostics.Count(d => d.Id == Gs0286));
    }
}
