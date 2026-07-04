// <copyright file="Issue1930DeferBlockFormRoundTripTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1930: <see cref="DeferStatement"/> used to
/// hold a <see cref="BlockStatement"/> body and the printer rendered
/// <c>defer { … }</c>, but the G# parser (<c>Parser.ParseDeferStatement</c>)
/// only ever accepted a single expression operand, per ADR-0030 (the
/// operand must bind to a call expression). Every printed
/// <see cref="DeferStatement"/> therefore failed to re-parse with GS0005.
/// The fix makes the code model match the documented, parser-enforced
/// canonical form: <c>defer &lt;call-expression&gt;</c>, no block form.
/// </summary>
public class Issue1930DeferBlockFormRoundTripTests
{
    [Fact]
    public void DeferStatement_PrintsSingleCallExpression_NotBlock()
    {
        var printed = GSharpPrinter.Print(DeferSample());

        Assert.Contains("defer cleanup()", printed);
        Assert.DoesNotContain("defer {", printed);
    }

    [Fact]
    public void DeferStatement_PrintedForm_RoundTripsThroughRealParser()
    {
        var printed = GSharpPrinter.Print(DeferSample());
        var result = GSharpRoundTrip.Validate(printed);

        Assert.True(result.Success, $"Printed G#:\n{printed}\nParse errors:\n{string.Join("\n", result.Errors)}");
    }

    private static CompilationUnit DeferSample() =>
        new CompilationUnit(
            "Demo",
            members: new List<GNode>
            {
                new MethodDeclaration(
                    "Run",
                    body: new BlockStatement(new List<GStatement>
                    {
                        new DeferStatement(new InvocationExpression(new IdentifierExpression("cleanup"))),
                    })),
            });
}
