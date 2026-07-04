// <copyright file="Issue1908CompoundAssignmentOperatorDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1908: a C# 14 user-defined INSTANCE
/// compound-assignment operator declaration (<c>public void operator +=(T
/// other)</c>, backed by <c>op_AdditionAssignment</c> and siblings) used to
/// translate its C# operator token text verbatim into a G# operator
/// declaration (<c>func (self T) operator +=(other T) { ... }</c>). G#
/// operator declarations only have binary/unary form (ADR-0035) — there is
/// no compound-assignment declaration syntax — so the emitted G# failed to
/// round-trip parse with <c>GS0005 Unexpected token &lt;PlusEqualsToken&gt;,
/// expected &lt;PlusToken&gt;</c>.
///
/// There is no lossless mechanical rewrite to a binary <c>operator +</c>:
/// the compound form mutates instance state in place rather than returning a
/// new value, and G# has no compound-assignment declaration/consumption
/// surface at all. The translator now reports this construct as a loud,
/// non-silent <c>CS2GS-GAP</c> (ADR-0115 §B) instead of emitting invalid G#
/// syntax; the operator member is dropped from the translated output (grid
/// app G07, tracked as a known/open gap in
/// <c>tools/cs2gs/triage/gaps.json</c>).
/// </summary>
public class Issue1908CompoundAssignmentOperatorDeclarationTests
{
    [Theory]
    [InlineData("+=", "int")]
    [InlineData("-=", "int")]
    [InlineData("*=", "int")]
    [InlineData("/=", "int")]
    [InlineData("%=", "int")]
    [InlineData("&=", "int")]
    [InlineData("|=", "int")]
    [InlineData("^=", "int")]
    [InlineData("<<=", "int")]
    [InlineData(">>=", "int")]
    [InlineData(">>>=", "int")]
    public void InstanceCompoundAssignmentOperator_ReportsUnsupportedInsteadOfInvalidSyntax(
        string compoundToken, string paramType)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", $@"
namespace Demo
{{
    public class TallyBag
    {{
        private int _total;

        public TallyBag(int start)
        {{
            _total = start;
        }}

        public void operator {compoundToken}({paramType} amount)
        {{
            _total = _total + amount;
        }}

        public int Total()
        {{
            return _total;
        }}
    }}
}}"),
        });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(System.Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("compound-assignment")
                && d.Message.Contains($"operator {compoundToken}"));
    }

    /// <summary>
    /// The dropped operator member must not leak the raw C# compound-assignment
    /// token (e.g. <c>operator +=</c>) into the printed G# — that shape fails
    /// round-trip parse with GS0005 (the original bug). The rest of the type
    /// (fields, other members) still translates normally.
    /// </summary>
    [Fact]
    public void InstanceCompoundAssignmentOperator_DoesNotEmitInvalidOperatorSyntax()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
namespace Demo
{
    public class TallyBag
    {
        private int _total;

        public TallyBag(int start)
        {
            _total = start;
        }

        public void operator +=(int amount)
        {
            _total = _total + amount;
        }

        public int Total()
        {
            return _total;
        }
    }
}"),
        });
        Assert.True(project.BoundWithoutErrors);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = Cs2Gs.CodeModel.Printing.GSharpPrinter.Print(unit);

        Assert.DoesNotContain("operator +=", printed);
        Assert.Contains("Total", printed);
    }
}
