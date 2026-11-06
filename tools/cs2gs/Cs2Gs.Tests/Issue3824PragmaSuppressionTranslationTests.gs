// <copyright file="Issue3824PragmaSuppressionTranslationTests.cs" company="GSharp">
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

/// Issues #3820 / #3824, ADR-0175: a C# `#pragma warning disable GSA####`
/// region covering a declaration translates to an
/// `@SuppressDiagnostic("GSA####")` annotation on the migrated
/// declaration. Identifier families that name analyzers which do not run on G#
/// (StyleCop `SA`, the C# compiler `CS`, the Roslyn ecosystem
/// `CA`/`IDE`/`VSTHRD`/`RS`) are dropped, not carried.
open class Issue3824PragmaSuppressionTranslationTests {
    @Fact
    func GsaPragmaRegion_BecomesSuppressDiagnosticOnTheCoveredMethod() {
        const source = `
public class Rewriter
{
    public int Untouched() => 1;

#pragma warning disable GSA0005
    public int Suppressed() => 2;
#pragma warning restore GSA0005

    public int AlsoUntouched() => 3;
}
`
        let printed = Translate(source)
        Assert.Contains("@SuppressDiagnostic(\"GSA0005\")", printed, StringComparison.Ordinal)
        // Scoping proof at the translator level: exactly ONE annotation is
        // emitted, on the one method the C# region covered. A file- or
        // project-level bridge would produce zero here and suppress everything.
        Assert.Equal(1, CountOccurrences(printed, "@SuppressDiagnostic"))
        let annotation = printed.IndexOf("@SuppressDiagnostic", StringComparison.Ordinal)
        let suppressed = printed.IndexOf("Suppressed", StringComparison.Ordinal)
        let alsoUntouched = printed.IndexOf("AlsoUntouched", StringComparison.Ordinal)
        Assert.True(annotation < suppressed, "annotation must precede the method it covers")
        Assert.True(suppressed < alsoUntouched, "the following method must be unannotated")
    }

    @Fact
    func MultipleRegions_EachAnnotateTheirOwnMethod() {
        const source = `
public class Rewriter
{
#pragma warning disable GSA0005
    public int First() => 1;
#pragma warning restore GSA0005

    public int Middle() => 2;

#pragma warning disable GSA0005
    public int Second() => 3;
#pragma warning restore GSA0005
}
`
        let printed = Translate(source)
        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GSA0005\")"))
    }

    @Fact
    func NonGsaPragmas_AreDropped() {
        const source = `
public class Sample
{
#pragma warning disable SA1600, CS1591, CA1822, IDE0060, RS2008
    public int Documented() => 1;
#pragma warning restore SA1600, CS1591, CA1822, IDE0060, RS2008
}
`
        let printed = Translate(source)
        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal)
    }

    @Fact
    func MixedRegion_CarriesOnlyTheGsaIdentifier() {
        const source = `
public class Sample
{
#pragma warning disable SA1600, GSA0005, CS1591
    public int Mixed() => 1;
#pragma warning restore SA1600, GSA0005, CS1591
}
`
        let printed = Translate(source)
        Assert.Contains("@SuppressDiagnostic(\"GSA0005\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("SA1600", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("CS1591", printed, StringComparison.Ordinal)
    }

    @Fact
    func FileWideRegion_AnnotatesEveryCoveredMethod() {
        const source = `
#pragma warning disable GSA0005
public class Sample
{
    public int A() => 1;

    public int B() => 2;
}
#pragma warning restore GSA0005
`
        let printed = Translate(source)
        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GSA0005\")"))
    }

    @Fact
    func TranslatedSuppression_BindsInTheMigratedTree() {
        const source = `
public class Rewriter
{
#pragma warning disable GSA0005
    public int Suppressed() => 2;
#pragma warning restore GSA0005
}
`
        let printed = Translate(source)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
    }

    @Fact
    func StatementScopedGsaPragmaInsideMethodBody_WrapsInSuppressDiagnosticBlockAndBinds() {
        const source = `
public class MemberLookup
{
    private static int Door(int x) => x + 1;

    public static int MapOpenSignature(int x)
    {
        var before = x;
#pragma warning disable GSA0007
        var projected = Door(before);
        var adjusted = projected + 1;
#pragma warning restore GSA0007
        return before;
    }
}
`
        let (printed, diagnostics) = TranslateWithDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED")
        Assert.Contains("@SuppressDiagnostic(\"GSA0007\") {", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "@SuppressDiagnostic(\"GSA0007\")"))
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
        let tree = GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SyntaxTree
            .Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(printed))
        let suppressionMap = GSharp
            .Core
            .CodeAnalysis
            .Analyzers
            .DiagnosticSuppressionMap
            .Build([]GSharp.Core.CodeAnalysis.Syntax.SyntaxTree{tree})
        let descriptor = GSharp
            .Core
            .CodeAnalysis
            .DiagnosticDescriptor(
            "GSA0007",
            "Title",
            "Message",
            "InternalAnalyzers",
            GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )
        let doorCallOffset = printed.IndexOf("Door(before)", StringComparison.Ordinal)
        let returnOffset = printed.IndexOf("return before", StringComparison.Ordinal)
        Assert.True(
            suppressionMap.IsSuppressed(
                GSharp
                    .Core
                    .CodeAnalysis
                    .Diagnostic
                    .Create(
                    descriptor,
                    GSharp
                        .Core
                        .CodeAnalysis
                        .Text
                        .TextLocation(tree.Text, GSharp.Core.CodeAnalysis.Text.TextSpan(doorCallOffset, 4))
                )
            )
        )
        Assert.False(
            suppressionMap.IsSuppressed(
                GSharp
                    .Core
                    .CodeAnalysis
                    .Diagnostic
                    .Create(
                    descriptor,
                    GSharp
                        .Core
                        .CodeAnalysis
                        .Text
                        .TextLocation(tree.Text, GSharp.Core.CodeAnalysis.Text.TextSpan(returnOffset, 6))
                )
            )
        )
    }

    @Fact
    func StatementScopedGsaPragmaOnLocalUsedLater_AnnotatesLocalDeclarationAndBinds() {
        const source = `
public class MemberLookup
{
    private static int Door(int x) => x + 1;

    public static int MapOpenSignature(int x)
    {
#pragma warning disable GSA0007
        var projected = Door(x);
#pragma warning restore GSA0007
        return projected;
    }
}
`
        let (printed, diagnostics) = TranslateWithDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED")
        Assert.Contains("@SuppressDiagnostic(\"GSA0007\") let projected", printed, StringComparison.Ordinal)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
    }

    @Fact
    func MidExpressionGsaPragma_ReportsPragmaDroppedDiagnostic() {
        const source = `
public class MemberLookup
{
    private static int Door(int x) => x + 1;

    public static int MapOpenSignature(int x)
    {
        return x +
#pragma warning disable GSA0007
            Door(x);
#pragma warning restore GSA0007
    }
}
`
        let (printed, diagnostics) = TranslateWithDiagnostics(source)
        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal)
        let dropped = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED")
        Assert.Contains("GSA0007", dropped.Message, StringComparison.Ordinal)
    }

    @Fact
    func PartiallyCoveredNextStatement_ReportsPragmaDroppedDiagnostic() {
        const source = `
public class MemberLookup
{
    private static int Door(int x) => x + 1;

    public static int MapOpenSignature(int x)
    {
#pragma warning disable GSA0007
        Door(x);
        return Door(x) +
#pragma warning restore GSA0007
            1;
    }
}
`
        let (printed, diagnostics) = TranslateWithDiagnostics(source)
        Assert.Contains("@SuppressDiagnostic(\"GSA0007\") {", printed, StringComparison.Ordinal)
        let dropped = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED")
        Assert.Contains("GSA0007", dropped.Message, StringComparison.Ordinal)
    }

    @Fact
    func GuardedFieldEarlyReturnUnderStatementPragma_DoesNotLeakOutOfScopeCapture() {
        const source = `
#nullable enable
public class Holder
{
    public string? Name { get; }

    public string Format()
    {
#pragma warning disable GSA0007
        if (Name == null)
        {
            return "";
        }
#pragma warning restore GSA0007

        return Name.ToUpperInvariant();
    }
}
`
        let (printed, diagnostics) = TranslateWithDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED")
        Assert.Contains("@SuppressDiagnostic(\"GSA0007\") {", printed, StringComparison.Ordinal)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors) + "\n" + printed)
    }

    @Fact
    func GetterOnlyPragmaOnReadWriteProperty_IsNotPromotedToWholeProperty() {
        const source = `
public class Sample
{
    private int _v;

    public int Value
    {
#pragma warning disable GSA0007
        get => _v;
#pragma warning restore GSA0007
        set => _v = value;
    }
}
`
        let (printed, diagnostics) = TranslateWithDiagnostics(source)
        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal)
        Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED")
    }

    @Fact
    func MultiNamespacePackageSplit_OnlyReportsPragmasForOwnedPackage() {
        const source = `
namespace First
{
    public class A
    {
        public int Run(int x) => x;
    }
}

namespace Second
{
    public class B
    {
        private static int Door(int x) => x + 1;

        public int Run(int x)
        {
#pragma warning disable GSA0007
            var v = Door(x);
            return v;
#pragma warning restore GSA0007
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Multi.cs", source)})
        let document = Assert.Single(project.Documents)
        let firstContext = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let firstTranslator = CSharpToGSharpTranslator(packageFilter: "First", includeGlobalNamespace: true)
        let firstPrinted = GSharpPrinter.Print(firstTranslator.TranslateDocument(document, firstContext))
        Assert.DoesNotContain(
            firstContext.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED"
        )
        Assert.DoesNotContain("@SuppressDiagnostic", firstPrinted, StringComparison.Ordinal)

        let secondContext = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let secondTranslator = CSharpToGSharpTranslator(packageFilter: "Second", includeGlobalNamespace: false)
        let secondPrinted = GSharpPrinter.Print(secondTranslator.TranslateDocument(document, secondContext))
        Assert.DoesNotContain(
            secondContext.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-PRAGMA-DROPPED"
        )
        Assert.Contains("@SuppressDiagnostic(\"GSA0007\") {", secondPrinted, StringComparison.Ordinal)
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }

        private func Translate(source string) string {
            let (printed, _) = TranslateWithDiagnostics(source)
            return printed
        }

        private func TranslateWithDiagnostics(source string)(
            Printed string,
            Diagnostics System.Collections.Generic.IReadOnlyList[TranslationDiagnostic]
        ) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Program.cs", source)})
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (GSharpPrinter.Print(unit), context.Diagnostics)
        }
    }
}
