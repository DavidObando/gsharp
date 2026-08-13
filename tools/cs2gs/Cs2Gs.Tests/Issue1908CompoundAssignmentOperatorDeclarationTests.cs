// <copyright file="Issue1908CompoundAssignmentOperatorDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1908, as resolved by issue #2834.
/// <para>
/// History: a C# 14 user-defined INSTANCE compound-assignment operator
/// declaration (<c>public void operator +=(T other)</c>, backed by
/// <c>op_AdditionAssignment</c> and siblings) originally translated its C#
/// operator token text verbatim into the G# top-level receiver-clause operator
/// form (<c>func (self T) operator +=(other T) { ... }</c>). G# only had
/// binary/unary operator declarations (ADR-0035), so the emitted G# failed to
/// round-trip parse with <c>GS0005 Unexpected token &lt;PlusEqualsToken&gt;,
/// expected &lt;PlusToken&gt;</c>. As a stopgap (#1908) the construct was
/// reported as a loud <c>CS2GS-GAP</c> and dropped.
/// </para>
/// <para>
/// G# now has first-class compound-assignment operator declarations (#2834), so
/// the construct translates to the IN-BODY member form
/// <c>func operator +=(other T)</c> — instance, <c>void</c>-returning,
/// <c>specialname</c>, exactly like Roslyn's. These tests keep the original
/// #1908 guarantee (the printed G# must round-trip parse) while pinning the
/// new, non-lossy translation.
/// </para>
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
    public void InstanceCompoundAssignmentOperator_TranslatesAndRoundTripParses(
        string compoundToken, string paramType)
    {
        CompilationUnit unit = Translate(compoundToken, paramType, out TranslationContext context);

        // No longer a gap.
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        // Emitted as an in-body instance member: no receiver clause (that form
        // is rewritten to a *static* op_*, which is the wrong shape here) and
        // no return type.
        TypeDeclaration bag = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "TallyBag");
        MethodDeclaration op = bag.Members
            .OfType<MethodDeclaration>()
            .Single(m => m.Name == "operator " + compoundToken);

        Assert.Null(op.Receiver);
        Assert.Null(op.ReturnType);
        Assert.Single(op.Parameters);

        Assert.DoesNotContain(
            unit.Members.OfType<MethodDeclaration>(),
            m => m.Name.StartsWith("operator ", StringComparison.Ordinal));

        // The original #1908 bug: the printed G# must parse (it used to fail
        // with GS0005).
        string printed = GSharpPrinter.Print(unit);
        Assert.Contains("func operator " + compoundToken + "(amount int32)", printed, StringComparison.Ordinal);

        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    /// <summary>
    /// The rest of the type still translates normally alongside the operator.
    /// </summary>
    [Fact]
    public void InstanceCompoundAssignmentOperator_DoesNotDropSiblingMembers()
    {
        CompilationUnit unit = Translate("+=", "int", out _);
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("operator +=", printed, StringComparison.Ordinal);
        Assert.Contains("Total", printed, StringComparison.Ordinal);
    }

    private static CompilationUnit Translate(string compoundToken, string paramType, out TranslationContext context)
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
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }
}
