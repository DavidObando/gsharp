// <copyright file="Issue2370ExplicitInterfaceStaticMemberTests.cs" company="GSharp">
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

/// ADR-0149 follow-up (issue #2362/PR #2370, "final completion pass"):
/// extends the explicit-interface `(IFoo)` qualifier clause to STATIC
/// members — C# 11 `static abstract`/`static virtual` interface
/// methods and properties (ADR-0089/#755/#1019) can be explicitly
/// implemented (`static int IFoo.M() { ... }`,
/// `static int IFoo.P { get; }`), exactly like their instance
/// counterparts. The existing method/property translation paths
/// (`TranslateMethod`/`TranslatePropertyOrIndexer`) already key
/// off Roslyn's (cref:Microsoft.CodeAnalysis.IMethodSymbol.ExplicitInterfaceImplementations) /
/// (cref:Microsoft.CodeAnalysis.IPropertySymbol.ExplicitInterfaceImplementations)
/// without special-casing `IsStatic` — the `static` classification and
/// routing into a G# `shared { }` block happens as an orthogonal, later
/// step, so no translator changes were required; these tests are pure
/// regression coverage proving the combination works end-to-end.
///
/// There is no static indexer or static event form in C#/the CLR at all
/// (indexers always require an instance receiver; interfaces cannot declare
/// `static abstract`/`static virtual` events) — this is a genuine
/// language/CLR limitation, not a translator gap, so only methods and
/// properties are covered here.
open class Issue2370ExplicitInterfaceStaticMemberTests {
    /// A lone static explicit interface METHOD implementation translates to
    /// a `shared` method carrying an ADR-0149 explicit-interface
    /// qualifier clause, with C#-faithful (non-public) visibility — mirrors
    /// `Issue1911ExplicitInterfaceImplementationTests.LoneExplicitImplementation_TranslatesToExplicitInterfaceClauseMethod`
    /// for the static case.
    @Fact
    func LoneStaticExplicitMethodImplementation_TranslatesToExplicitInterfaceClauseMethod() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2370Static
{
    public interface IFactory
    {
        static abstract int Create();
    }

    public class Widget : IFactory
    {
        static int IFactory.Create()
        {
            return 42;
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("private func (IFactory) Create() int32 {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "explicit interface",
                StringComparison.OrdinalIgnoreCase
            )
        )
        AssertRoundTripParses(printed)
    }

    /// A lone static explicit interface PROPERTY implementation translates
    /// to a `shared` property carrying the clause, C#-faithful
    /// visibility, mirroring the instance property equivalent.
    @Fact
    func LoneStaticExplicitPropertyImplementation_TranslatesToExplicitInterfaceClauseProperty() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2370Static
{
    public interface ISized
    {
        static abstract int SizeInBytes { get; }
    }

    public class Blob : ISized
    {
        static int ISized.SizeInBytes => 8;
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("(ISized)", printed, StringComparison.Ordinal)
        Assert.Contains("SizeInBytes", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "explicit interface",
                StringComparison.OrdinalIgnoreCase
            )
        )
        AssertRoundTripParses(printed)
    }

    /// A static explicit method implementation coexisting with a same-named
    /// ordinary (non-explicit) public static method on the same class: both
    /// survive as distinct, clause-disambiguated G# members — the static
    /// counterpart of the instance collision regression covered by
    /// `Issue2010ExplicitInterfaceImplementationTests`.
    @Fact
    func StaticExplicitMethodCoexistingWithPublicStaticMethod_BothSurvive() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2370Static
{
    public interface ICounter
    {
        static abstract int Next();
    }

    public class Sequence : ICounter
    {
        public static int Next()
        {
            return 1;
        }

        static int ICounter.Next()
        {
            return 2;
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("private func (ICounter) Next() int32 {", printed, StringComparison.Ordinal)
        Assert.Contains("Next() int32", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "explicit interface",
                StringComparison.OrdinalIgnoreCase
            )
        )
        AssertRoundTripParses(printed)
    }

    shared {
        private func Translate(source string)(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }

        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }
    }
}
