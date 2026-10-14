// <copyright file="DiagnosticBagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Linq
import Xunit

open class DiagnosticBagTests {
    @Fact
    func Report_Adds_Diagnostic_And_Is_Enumerable() {
        let bag = DiagnosticBag()
        let location = MakeLocation("hello world")
        bag.ReportUnterminatedString(location)
        bag.ReportBadCharacter(location, '`')
        let diagnostics = bag.ToArray()
        Assert.Equal(2, diagnostics.Length)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("Unterminated string"))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("`"))
    }

    @Fact
    func AddRange_Copies_From_Source_Bag() {
        let location = MakeLocation("source")
        let source = DiagnosticBag()
        source.ReportUnexpectedToken(location, SyntaxKind.PlusToken, SyntaxKind.NumberToken)
        source.ReportInvalidReturn(location)
        let target = DiagnosticBag()
        target.AddRange(source)
        Assert.Equal(2, target.Count())
    }

    @Fact
    func SuppressDuplicateDiagnosticsIn_ConsumesExistingMultiplicityOnly() {
        let location = MakeLocation("source")
        let existing = Diagnostic(location, "GS0002", DiagnosticSeverity.Warning, "same")
        let repeated = Diagnostic(location, "GS0002", DiagnosticSeverity.Warning, "same")
        let distinct = Diagnostic(location, "GS0003", DiagnosticSeverity.Error, "distinct")
        let bag = DiagnosticBag()
        bag.Report(existing)
        bag.SuppressDuplicateDiagnosticsIn(
            location,
            () -> {
                bag.Report(Diagnostic(location, "GS0002", DiagnosticSeverity.Warning, "same"))
                bag.Report(repeated)
                bag.Report(distinct)
                return 0
            }
        )
        Assert.Equal([]Diagnostic{existing, repeated, distinct}, bag)
    }

    @Fact
    func Transaction_RollbackRemovesOnlyDiagnosticsAddedByTransaction() {
        let location = MakeLocation("source")
        let existing = Diagnostic(location, "GS0001", DiagnosticSeverity.Warning, "existing")
        let rolledBack = Diagnostic(location, "GS0002", DiagnosticSeverity.Error, "rolled back")
        let bag = DiagnosticBag()
        bag.Report(existing)
        {
            using let _ = bag.BeginTransaction()
            bag.Report(rolledBack)
        }
        Assert.Equal([]Diagnostic{existing}, bag)
    }

    @Fact
    func Diagnostic_ToString_Returns_Message() {
        let location = MakeLocation("x")
        let d = Diagnostic(location, "boom")
        Assert.Equal("boom", d.ToString())
        Assert.Equal(location, d.Location)
    }

    @Fact
    func Diagnostic_WithIdAndSeverity_ExposesProperties() {
        let location = MakeLocation("x")
        let d = Diagnostic(location, "GS0042", DiagnosticSeverity.Warning, "test warning")
        Assert.Equal("GS0042", d.Id)
        Assert.Equal(DiagnosticSeverity.Warning, d.Severity)
        Assert.False(d.IsError)
        Assert.Equal("test warning", d.Message)
        Assert.Equal("test warning", d.ToString())
    }

    @Fact
    func DiagnosticBag_ReportMethods_AssignStableIds() {
        let location = MakeLocation("bad char")
        let bag = DiagnosticBag()
        bag.ReportBadCharacter(location, '`')
        bag.ReportUnterminatedString(location)
        bag.ReportUnexpectedToken(location, SyntaxKind.PlusToken, SyntaxKind.NumberToken)
        bag.ReportUndefinedVariable(location, "x")
        let diagnostics = bag.ToArray()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0001")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0003")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0005")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Equal(DiagnosticSeverity.Error, d.Severity))
    }

    @Fact
    func DescriptorFormatting_Preserves_MessageVariants_And_DynamicSeverity() {
        let location = MakeLocation("x")
        let bag = DiagnosticBag()
        bag.ReportAmbiguousOverload(location, "F", 2, []string{"F(int32)", string.Empty, "F(string)"})
        bag.ReportObsoleteUse(location, "Old", nil, false)
        bag.ReportObsoleteUse(location, "Old", "use New", true)
        Assert.Collection(
            bag,
            (diagnostic Diagnostic) -> Assert.Equal(
                "Call to 'F' is ambiguous between 2 applicable overloads. Candidates: F(int32); F(string).",
                diagnostic.Message
            ),
            (diagnostic Diagnostic) -> {
                Assert.Equal("'Old' is obsolete.", diagnostic.Message)
                Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity)
            },
            (diagnostic Diagnostic) -> {
                Assert.Equal("'Old' is obsolete: 'use New'.", diagnostic.Message)
                Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity)
            }
        )
    }

    shared {
        private func MakeLocation(text string) TextLocation {
            let source = SourceText.From(text)
            return TextLocation(source, TextSpan(0, text.Length))
        }
    }
}
