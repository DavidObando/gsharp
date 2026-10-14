// <copyright file="Issue2010ExplicitInterfaceImplementationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2010 (follow-up to #1911 / PR #1994 review): the #1911 fix forced
/// explicit interface implementations public and DROPPED any colliding
/// same-name/same-signature sibling (another explicit impl, or a coexisting
/// public method) via an (cref:TranslationSeverity.Unsupported)
/// diagnostic — surfacing the loss instead of silently emitting wrong
/// behavior, but still losing a distinct body.
///
/// This fix instead preserves full fidelity, zero drops: every explicit
/// interface implementation is emitted as its own G# method carrying an
/// ADR-0149 explicit-interface qualifier clause (issue #2362 redesign;
/// originally a reserved `__explicit_<Interface>__<Member>`
/// mangled name) that gsc's binder recognizes and links to the specific
/// interface member it implements (`FunctionSymbol.ExplicitInterfaceClauseTarget`);
/// the emitter binds a CLR `MethodImpl` row per implementation (reusing
/// the ADR-0089 static-virtual / issue #985 bridge machinery) so each
/// interface's dispatch slot routes to its own distinct method body. Since
/// the clause names the interface directly (not by encoding it into the
/// member's own identifier), two explicit implementations of the same
/// member from different interfaces never collide — no GS0264, no drop, no
/// diagnostic, and each keeps its unqualified source name.
open class Issue2010ExplicitInterfaceImplementationTests {
    /// Two explicit implementations of the SAME-NAME, SAME-SIGNATURE member
    /// from two DIFFERENT interfaces (a same-name diamond, no public sibling)
    /// both survive translation as two distinct methods, each carrying its
    /// own explicit-interface qualifier clause — the #1911 "de-duplicate to
    /// one survivor + Unsupported diagnostic" gap no longer applies.
    @Fact
    func TwoCollidingExplicitImplementations_BothSurviveWithDistinctClauses() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2010
{
    public interface IGreeter
    {
        string Greet();
    }

    public interface IWelcomer
    {
        string Greet();
    }

    public class Multi : IGreeter, IWelcomer
    {
        string IGreeter.Greet()
        {
            return "hi";
        }

        string IWelcomer.Greet()
        {
            return "welcome";
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        let multi = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Multi")
        let greetMethods = multi
            .Members
            .OfType[MethodDeclaration]()
            .Where((m MethodDeclaration) -> m.Name == "Greet")
            .ToList()
        Assert.Equal(2, greetMethods.Count)
        Assert.Contains(
            greetMethods,
            (m MethodDeclaration) -> m.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IGreeter"
        )
        Assert.Contains(
            greetMethods,
            (m MethodDeclaration) -> m.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IWelcomer"
        )
        Assert.Contains("(IGreeter) Greet", printed, StringComparison.Ordinal)
        Assert.Contains("(IWelcomer) Greet", printed, StringComparison.Ordinal)
        Assert.Contains("hi", printed, StringComparison.Ordinal)
        Assert.Contains("welcome", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "explicit interface",
                StringComparison.OrdinalIgnoreCase
            )
        )
        AssertRoundTripParses(printed)
    }

    /// An explicit implementation coexisting with a same-signature public
    /// method of the same name no longer collides at all: the public method
    /// keeps its plain name with no clause, and the explicit implementation
    /// gets its own explicit-interface qualifier clause and its own body —
    /// both survive as two distinct methods that happen to share a source
    /// name (disambiguated at the CLR level by the clause-driven MethodImpl
    /// binding, not by name).
    @Fact
    func ExplicitImplementationCoexistingWithPublicMethod_BothSurvive() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2010
{
    public interface IGreeter
    {
        string Greet();
    }

    public class LoudHost : IGreeter
    {
        public string Greet()
        {
            return "hello-public";
        }

        string IGreeter.Greet()
        {
            return "hello-explicit";
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        let loudHost = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "LoudHost")
        let greetMethods = loudHost
            .Members
            .OfType[MethodDeclaration]()
            .Where((m MethodDeclaration) -> m.Name == "Greet")
            .ToList()
        Assert.Equal(2, greetMethods.Count)
        Assert.Contains(greetMethods, (m MethodDeclaration) -> m.ExplicitInterfaceType == nil)
        Assert.Contains(
            greetMethods,
            (m MethodDeclaration) -> m.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IGreeter"
        )
        Assert.Contains("hello-public", printed, StringComparison.Ordinal)
        Assert.Contains("hello-explicit", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "explicit interface",
                StringComparison.OrdinalIgnoreCase
            )
        )
        AssertRoundTripParses(printed)
    }

    /// Follow-up fix: two SAME-SIMPLE-NAME interfaces declared in DIFFERENT
    /// namespaces (`NsA.IBar` and `NsB.IBar`) previously mangled
    /// to the identical `__explicit_IBar__M` name (bare simple name),
    /// producing a hard GS0264 duplicate-signature collision instead of the
    /// intended per-interface distinctness. Under the ADR-0149 clause
    /// redesign, each explicit implementation's clause carries the
    /// interface's own fully namespace-qualified type reference (e.g.
    /// `(NsA.IBar)` vs. `(NsB.IBar)`), so the two implementations
    /// are unambiguous even though both keep the exact same plain member
    /// name (`M`).
    @Fact
    func TwoSameSimpleNameInterfacesFromDifferentNamespaces_ClausesDisambiguate() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("NsA.cs", `
namespace NsA
{
    public interface IBar
    {
        string M();
    }
}`), ("NsB.cs", `
namespace NsB
{
    public interface IBar
    {
        string M();
    }
}`), ("Multi.cs", `
using NsA;
using NsB;

namespace Corpus.Issue2010
{
    public class Multi : NsA.IBar, NsB.IBar
    {
        string NsA.IBar.M()
        {
            return "from-a";
        }

        string NsB.IBar.M()
        {
            return "from-b";
        }
    }
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = project.Documents.Single((d LoadedDocument) -> d.FilePath == "Multi.cs")
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        let multi = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Multi")
        let mMethods = multi.Members.OfType[MethodDeclaration]().Where((m MethodDeclaration) -> m.Name == "M").ToList()
        // Both keep the SAME plain source name ("M") — disambiguation is via
        // the clause's interface type, not the member name.
        Assert.Equal(2, mMethods.Count)
        Assert.Contains("(NsA.IBar) M", printed, StringComparison.Ordinal)
        Assert.Contains("(NsB.IBar) M", printed, StringComparison.Ordinal)
        Assert.Contains("from-a", printed, StringComparison.Ordinal)
        Assert.Contains("from-b", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "explicit interface",
                StringComparison.OrdinalIgnoreCase
            )
        )
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

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
    }
}
