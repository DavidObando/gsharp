// <copyright file="Issue1908CompoundAssignmentOperatorDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Regression tests for issue #1908, as resolved by issue #2834.
///
/// History: a C# 14 user-defined INSTANCE compound-assignment operator
/// declaration (`public void operator +=(T other)`, backed by
/// `op_AdditionAssignment` and siblings) originally translated its C#
/// operator token text verbatim into the G# top-level receiver-clause operator
/// form (`func (self T) operator +=(other T) { ... }`). G# only had
/// binary/unary operator declarations (ADR-0035), so the emitted G# failed to
/// round-trip parse with `GS0005 Unexpected token <PlusEqualsToken>,
/// expected <PlusToken>`. As a stopgap (#1908) the construct was
/// reported as a loud `CS2GS-GAP` and dropped.
///
/// G# now has first-class compound-assignment operator declarations (#2834), so
/// the construct translates to the IN-BODY member form
/// `func operator +=(other T)` — instance, `void`-returning,
/// `specialname`, exactly like Roslyn's. These tests keep the original
/// #1908 guarantee (the printed G# must round-trip parse) while pinning the
/// new, non-lossy translation.
open class Issue1908CompoundAssignmentOperatorDeclarationTests {
    @Theory
    @InlineData("+=", "int")
    @InlineData("-=", "int")
    @InlineData("*=", "int")
    @InlineData("/=", "int")
    @InlineData("%=", "int")
    @InlineData("&=", "int")
    @InlineData("|=", "int")
    @InlineData("^=", "int")
    @InlineData("<<=", "int")
    @InlineData(">>=", "int")
    @InlineData(">>>=", "int")
    func InstanceCompoundAssignmentOperator_TranslatesAndRoundTripParses(compoundToken string, paramType string) {
        let unit = Translate(compoundToken, paramType, out var context)
        // No longer a gap.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        // Emitted as an in-body instance member: no receiver clause (that form
        // is rewritten to a *static* op_*, which is the wrong shape here) and
        // no return type.
        let bag = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "TallyBag")
        let op = bag
            .Members
            .OfType[MethodDeclaration]()
            .Single((m MethodDeclaration) -> m.Name == "operator " + compoundToken)
        Assert.Null(op.Receiver)
        Assert.Null(op.ReturnType)
        Assert.Single(op.Parameters)
        Assert.DoesNotContain(
            unit.Members.OfType[MethodDeclaration](),
            (m MethodDeclaration) -> m.Name.StartsWith("operator ", StringComparison.Ordinal)
        )
        // The original #1908 bug: the printed G# must parse (it used to fail
        // with GS0005).
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("func operator " + compoundToken + "(amount int32)", printed, StringComparison.Ordinal)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
    }

    /// The rest of the type still translates normally alongside the operator.
    @Fact
    func InstanceCompoundAssignmentOperator_DoesNotDropSiblingMembers() {
        let unit = Translate("+=", "int", out _)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("operator +=", printed, StringComparison.Ordinal)
        Assert.Contains("Total", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(compoundToken string, paramType string, out context TranslationContext) CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", (`
namespace Demo
{
    public class TallyBag
    {
        private int _total;

        public TallyBag(int start)
        {
            _total = start;
        }

        public void operator ` + "$compoundToken" + `(` + "$paramType" + ` amount)
        {
            _total = _total + amount;
        }

        public int Total()
        {
            return _total;
        }
    }
}`))})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return CSharpToGSharpTranslator().TranslateDocument(document, context)
        }
    }
}
