// <copyright file="Issue2370ExplicitInterfaceEventTests.cs" company="GSharp">
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

/// ADR-0149 follow-up (issue #2362/PR #2370): extends the explicit-interface
/// `(IFoo)` qualifier clause — previously supported for methods
/// (#2010/#2181), properties, and (as of this same PR) indexers — to
/// EVENTS. A C# explicit interface EVENT implementation (e.g. `event
/// EventHandler IObservable.Changed { add { ... } remove { ... } }`)
/// previously translated as an ordinary same-named event, colliding with a
/// same-named public concrete event on the class exactly like the
/// pre-fix property/indexer case.
///
/// Only the CUSTOM add/remove accessor form
/// (`EventDeclarationSyntax`) can carry an explicit interface
/// specifier in C# — a field-like event declaration
/// (`event Handler Name;`) can never be explicit, so
/// `TranslateEventField` is unaffected by this fix; only
/// `TranslateExplicitEvent` (the custom-accessor path) needed the
/// clause-based rewrite.
///
/// An explicit event implementation is emitted under its
/// own plain source name carrying a `(InterfaceType)` clause
/// immediately after the `event` keyword (e.g. `event (IObservable)
/// Changed EventHandler`), disambiguated by the clause rather than by
/// name. Issue #3535 extends the same clause and CLR-slot path to imported
/// interfaces.
open class Issue2370ExplicitInterfaceEventTests {
    /// A single custom-accessor explicit interface event implementation
    /// coexisting with a same-named public field-like event: both survive
    /// as distinct, clause-disambiguated G# events — the primary regression
    /// this fix addresses (previously a GS0102-style name collision).
    @Fact
    func ExplicitEventImplementationCoexistingWithPublicEvent_BothSurvive() {
        let (unit, context) = Translate(`
using System;

namespace Corpus.Issue2370
{
    public interface IWatcher
    {
        event EventHandler Changed;
    }

    public class Watcher : IWatcher
    {
        public event EventHandler Changed;

        event EventHandler IWatcher.Changed
        {
            add { Changed += value; }
            remove { Changed -= value; }
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        let watcher = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Watcher")
        let events = watcher
            .Members
            .OfType[EventDeclaration]()
            .Where((e EventDeclaration) -> e.Name == "Changed")
            .ToList()
        Assert.Equal(2, events.Count)
        Assert.Contains(
            events,
            (e EventDeclaration) -> e.ExplicitInterfaceType == nil && e.Visibility == Visibility.Default
        )
        Assert.Contains(
            events,
            (e EventDeclaration) -> e.ExplicitInterfaceType is NamedTypeReference n &&
                n.Name == "IWatcher" &&
                e.Visibility == Visibility.Private
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(printed)
    }

    /// A single explicit interface event implementation with NO colliding
    /// sibling still resolves via the clause (not merely forced-public,
    /// no-clause name-based dispatch) and is demoted to G# `private`
    /// visibility, mirroring the property/method-level convention exactly.
    @Fact
    func SingleExplicitEventImplementation_ClauseQualifiedAndPrivate() {
        let (unit, context) = Translate(`
using System;

namespace Corpus.Issue2370
{
    public interface IWatcher
    {
        event EventHandler Changed;
    }

    public class Watcher : IWatcher
    {
        event EventHandler IWatcher.Changed
        {
            add { }
            remove { }
        }
    }
}`)
        let watcher = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Watcher")
        let changed = watcher.Members.OfType[EventDeclaration]().Single((e EventDeclaration) -> e.Name == "Changed")
        Assert.Equal(Visibility.Private, changed.Visibility)
        Assert.True(changed.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IWatcher")
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// Two colliding explicit event implementations targeting DIFFERENT
    /// interfaces (diamond-style) both survive, each carrying its own
    /// distinct clause — mirroring
    /// `TwoCollidingExplicitPropertyImplementations_BothSurviveWithDistinctClauses`.
    @Fact
    func TwoCollidingExplicitEventImplementations_BothSurviveWithDistinctClauses() {
        let (unit, context) = Translate(`
using System;

namespace Corpus.Issue2370
{
    public interface IFoo
    {
        event EventHandler Changed;
    }

    public interface IBaz
    {
        event EventHandler Changed;
    }

    public class Both : IFoo, IBaz
    {
        event EventHandler IFoo.Changed
        {
            add { }
            remove { }
        }

        event EventHandler IBaz.Changed
        {
            add { }
            remove { }
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        let both = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Both")
        let events = both.Members.OfType[EventDeclaration]().Where((e EventDeclaration) -> e.Name == "Changed").ToList()
        Assert.Equal(2, events.Count)
        Assert.Contains(
            events,
            (e EventDeclaration) -> e.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IFoo"
        )
        Assert.Contains(
            events,
            (e EventDeclaration) -> e.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IBaz"
        )
        Assert.All(events, (e EventDeclaration) -> Assert.Equal(Visibility.Private, e.Visibility))
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(printed)
    }

    /// An explicit implementation of an event declared on an interface
    /// INHERITED by the directly-implemented interface still resolves and
    /// carries the clause naming the interface that ACTUALLY declares the
    /// member — mirroring the property-level inherited-interface test.
    @Fact
    func ExplicitEventImplementationOfInheritedInterfaceMember_ResolvesAndCarriesClause() {
        let (unit, context) = Translate(`
using System;

namespace Corpus.Issue2370
{
    public interface IBase
    {
        event EventHandler Changed;
    }

    public interface IDerived : IBase
    {
    }

    public class Impl : IDerived
    {
        event EventHandler IBase.Changed
        {
            add { }
            remove { }
        }
    }
}`)
        let impl = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Impl")
        let changed = impl.Members.OfType[EventDeclaration]().Single((e EventDeclaration) -> e.Name == "Changed")
        Assert.True(changed.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IBase")
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An EXTERNAL/BCL explicit event uses the ADR-0149 clause and coexists
    /// with a same-named public event.
    @Fact
    func ExternalInterfaceExplicitEventImplementation_CollidesWithPublicEvent_BothSurvive() {
        let (unit, context) = Translate(`
using System.ComponentModel;

namespace Corpus.Issue2370
{
    public class Model : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler PropertyChanged;

        event PropertyChangedEventHandler INotifyPropertyChanged.PropertyChanged
        {
            add { PropertyChanged += value; }
            remove { PropertyChanged -= value; }
        }
    }
}`)
        let model = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Model")
        let events = model
            .Members
            .OfType[EventDeclaration]()
            .Where((e EventDeclaration) -> e.Name == "PropertyChanged")
            .ToList()
        Assert.Equal(2, events.Count)
        Assert.Contains(events, (e EventDeclaration) -> e.ExplicitInterfaceType == nil)
        Assert.Contains(
            events,
            (e EventDeclaration) -> e.ExplicitInterfaceType is NamedTypeReference n &&
                n.Name == "INotifyPropertyChanged" &&
                e.Visibility == Visibility.Private
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An explicit implementation of an EXTERNAL interface event with no
    /// colliding sibling is clause-qualified and private.
    @Fact
    func ExternalInterfaceEventImplementation_NoCollision_ClauseQualifiedAndPrivate() {
        let (unit, context) = Translate(`
using System.ComponentModel;

namespace Corpus.Issue2370
{
    public class Model : INotifyPropertyChanged
    {
        event PropertyChangedEventHandler INotifyPropertyChanged.PropertyChanged
        {
            add { }
            remove { }
        }
    }
}`)
        let model = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Model")
        let propertyChanged = model
            .Members
            .OfType[EventDeclaration]()
            .Single((e EventDeclaration) -> e.Name == "PropertyChanged")
        Assert.Equal(Visibility.Private, propertyChanged.Visibility)
        Assert.True(propertyChanged.ExplicitInterfaceType is NamedTypeReference n && n.Name == "INotifyPropertyChanged")
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// Two same-simple-name interfaces declared in DIFFERENT namespaces
    /// disambiguate their explicit event implementations via the clause's
    /// fully namespace-qualified interface type reference — mirroring the
    /// method/property-level fix's namespace-qualification guarantee
    /// exactly, while both implementations keep the exact same plain source
    /// name (`Changed`).
    @Fact
    func TwoSameSimpleNameInterfacesFromDifferentNamespaces_ClausesDisambiguate() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("NsA.cs", `
using System;

namespace NsA
{
    public interface IWatcher
    {
        event EventHandler Changed;
    }
}`), ("NsB.cs", `
using System;

namespace NsB
{
    public interface IWatcher
    {
        event EventHandler Changed;
    }
}`), ("Both.cs", `
using System;
using NsA;
using NsB;

namespace Corpus.Issue2370
{
    public class Both : NsA.IWatcher, NsB.IWatcher
    {
        event EventHandler NsA.IWatcher.Changed
        {
            add { }
            remove { }
        }

        event EventHandler NsB.IWatcher.Changed
        {
            add { }
            remove { }
        }
    }
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let translator = CSharpToGSharpTranslator()
        let translated = project
            .Documents
            .Select(
            (document LoadedDocument) -> {
                let documentContext = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let documentUnit = translator.TranslateDocument(document, documentContext)
                return (document, documentContext, documentUnit, printed: GSharpPrinter.Print(documentUnit))
            }
        )
            .ToArray()
        let target = translated.Single(
            (
                result(
                    document LoadedDocument,
                    documentContext TranslationContext,
                    documentUnit CompilationUnit,
                    printed string
                )
            ) -> result
                .Item1
                .FilePath == "Both.cs"
        )
        let context = target.Item2
        let unit = target.Item3
        let printed = target.Item4
        let both = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Both")
        let events = both.Members.OfType[EventDeclaration]().Where((e EventDeclaration) -> e.Name == "Changed").ToList()
        Assert.Equal(2, events.Count)
        Assert.Contains("(NsA.IWatcher) Changed", printed, StringComparison.Ordinal)
        Assert.Contains("(NsB.IWatcher) Changed", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        for result in translated {
            let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                result.Item4,
                "Binder.BindGlobalScope cannot resolve qualified interfaces across this multi-package fixture."
            )
            Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
        }
    }

    /// The printer renders the `(InterfaceType)` clause immediately
    /// after the `event` keyword, matching the established
    /// method/property/indexer clause rendering convention exactly.
    @Fact
    func Printer_RendersExplicitInterfaceEventClause() {
        let (unit, _) = Translate(`
using System;

namespace Corpus.Issue2370
{
    public interface IWatcher
    {
        event EventHandler Changed;
    }

    public class Watcher : IWatcher
    {
        event EventHandler IWatcher.Changed
        {
            add { }
            remove { }
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("event (IWatcher) Changed", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
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
