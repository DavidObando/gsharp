// <copyright file="Issue1930DeferBlockFormRoundTripTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import System.Collections.Generic
import Xunit

/// Regression tests for issue #1930: (cref:DeferStatement) used to
/// hold a (cref:BlockStatement) body and the printer rendered
/// `defer { … }`, but the G# parser (`Parser.ParseDeferStatement`)
/// only ever accepted a single expression operand, per ADR-0030 (the
/// operand must bind to a call expression). Every printed
/// (cref:DeferStatement) therefore failed to re-parse with GS0005.
/// The fix makes the code model match the documented, parser-enforced
/// canonical form: `defer <call-expression>`, no block form.
open class Issue1930DeferBlockFormRoundTripTests {
    @Fact
    func DeferStatement_PrintsSingleCallExpression_NotBlock() {
        let printed = GSharpPrinter.Print(DeferSample())
        Assert.Contains("defer cleanup()", printed)
        Assert.DoesNotContain("defer {", printed)
    }

    @Fact
    func DeferStatement_PrintedForm_RoundTripsThroughRealParser() {
        let printed = GSharpPrinter.Print(DeferSample())
        let result = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "This parser regression fixture deliberately leaves cleanup() undefined."
        )
        Assert.True(result.Success, (`Printed G#:
` + "$printed" + `
Parse errors:
` + "${string.Join("\n", result.Errors)}"))
    }

    shared {
        private func DeferSample() CompilationUnit -> CompilationUnit(
            "Demo",
            members: List[GNode]{
                MethodDeclaration(
                    "Run",
                    body: BlockStatement(
                        List[GStatement]{DeferStatement(InvocationExpression(IdentifierExpression("cleanup")))}
                    )
                )
            }
        )
    }
}
