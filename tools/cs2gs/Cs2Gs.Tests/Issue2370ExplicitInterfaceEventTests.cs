// <copyright file="Issue2370ExplicitInterfaceEventTests.cs" company="GSharp">
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
/// ADR-0149 follow-up (issue #2362/PR #2370): extends the explicit-interface
/// <c>(IFoo)</c> qualifier clause — previously supported for methods
/// (#2010/#2181), properties, and (as of this same PR) indexers — to
/// EVENTS. A C# explicit interface EVENT implementation (e.g. <c>event
/// EventHandler IObservable.Changed { add { ... } remove { ... } }</c>)
/// previously translated as an ordinary same-named event, colliding with a
/// same-named public concrete event on the class exactly like the
/// pre-fix property/indexer case.
/// <para>
/// Only the CUSTOM add/remove accessor form
/// (<c>EventDeclarationSyntax</c>) can carry an explicit interface
/// specifier in C# — a field-like event declaration
/// (<c>event Handler Name;</c>) can never be explicit, so
/// <c>TranslateEventField</c> is unaffected by this fix; only
/// <c>TranslateExplicitEvent</c> (the custom-accessor path) needed the
/// clause-based rewrite.
/// </para>
/// <para>
/// An explicit event implementation is emitted under its
/// own plain source name carrying a <c>(InterfaceType)</c> clause
/// immediately after the <c>event</c> keyword (e.g. <c>event (IObservable)
/// Changed EventHandler</c>), disambiguated by the clause rather than by
/// name. Issue #3535 extends the same clause and CLR-slot path to imported
/// interfaces.
/// </para>
/// </summary>
public class Issue2370ExplicitInterfaceEventTests
{
    /// <summary>
    /// A single custom-accessor explicit interface event implementation
    /// coexisting with a same-named public field-like event: both survive
    /// as distinct, clause-disambiguated G# events — the primary regression
    /// this fix addresses (previously a GS0102-style name collision).
    /// </summary>
    [Fact]
    public void ExplicitEventImplementationCoexistingWithPublicEvent_BothSurvive()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
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
}");
        string printed = GSharpPrinter.Print(unit);

        TypeDeclaration watcher = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Watcher");
        var events = watcher.Members.OfType<EventDeclaration>().Where(e => e.Name == "Changed").ToList();

        Assert.Equal(2, events.Count);
        Assert.Contains(events, e => e.ExplicitInterfaceType == null && e.Visibility == Visibility.Default);
        Assert.Contains(
            events,
            e => e.ExplicitInterfaceType is NamedTypeReference n
                && n.Name == "IWatcher"
                && e.Visibility == Visibility.Private);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// A single explicit interface event implementation with NO colliding
    /// sibling still resolves via the clause (not merely forced-public,
    /// no-clause name-based dispatch) and is demoted to G# <c>private</c>
    /// visibility, mirroring the property/method-level convention exactly.
    /// </summary>
    [Fact]
    public void SingleExplicitEventImplementation_ClauseQualifiedAndPrivate()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
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
}");
        TypeDeclaration watcher = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Watcher");
        EventDeclaration changed = watcher.Members.OfType<EventDeclaration>().Single(e => e.Name == "Changed");

        Assert.Equal(Visibility.Private, changed.Visibility);
        Assert.True(changed.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IWatcher");
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// Two colliding explicit event implementations targeting DIFFERENT
    /// interfaces (diamond-style) both survive, each carrying its own
    /// distinct clause — mirroring
    /// <c>TwoCollidingExplicitPropertyImplementations_BothSurviveWithDistinctClauses</c>.
    /// </summary>
    [Fact]
    public void TwoCollidingExplicitEventImplementations_BothSurviveWithDistinctClauses()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
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
}");
        string printed = GSharpPrinter.Print(unit);

        TypeDeclaration both = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Both");
        var events = both.Members.OfType<EventDeclaration>().Where(e => e.Name == "Changed").ToList();

        Assert.Equal(2, events.Count);
        Assert.Contains(events, e => e.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IFoo");
        Assert.Contains(events, e => e.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IBaz");
        Assert.All(events, e => Assert.Equal(Visibility.Private, e.Visibility));

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// An explicit implementation of an event declared on an interface
    /// INHERITED by the directly-implemented interface still resolves and
    /// carries the clause naming the interface that ACTUALLY declares the
    /// member — mirroring the property-level inherited-interface test.
    /// </summary>
    [Fact]
    public void ExplicitEventImplementationOfInheritedInterfaceMember_ResolvesAndCarriesClause()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
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
}");
        TypeDeclaration impl = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Impl");
        EventDeclaration changed = impl.Members.OfType<EventDeclaration>().Single(e => e.Name == "Changed");

        Assert.True(changed.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IBase");
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// An EXTERNAL/BCL explicit event uses the ADR-0149 clause and coexists
    /// with a same-named public event.
    /// </summary>
    [Fact]
    public void ExternalInterfaceExplicitEventImplementation_CollidesWithPublicEvent_BothSurvive()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
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
}");
        TypeDeclaration model = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Model");
        var events = model.Members.OfType<EventDeclaration>().Where(e => e.Name == "PropertyChanged").ToList();

        Assert.Equal(2, events.Count);
        Assert.Contains(events, e => e.ExplicitInterfaceType == null);
        Assert.Contains(
            events,
            e => e.ExplicitInterfaceType is NamedTypeReference n
                && n.Name == "INotifyPropertyChanged"
                && e.Visibility == Visibility.Private);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// An explicit implementation of an EXTERNAL interface event with no
    /// colliding sibling is clause-qualified and private.
    /// </summary>
    [Fact]
    public void ExternalInterfaceEventImplementation_NoCollision_ClauseQualifiedAndPrivate()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
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
}");
        TypeDeclaration model = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Model");
        EventDeclaration propertyChanged = model.Members.OfType<EventDeclaration>().Single(e => e.Name == "PropertyChanged");

        Assert.Equal(Visibility.Private, propertyChanged.Visibility);
        Assert.True(propertyChanged.ExplicitInterfaceType is NamedTypeReference n && n.Name == "INotifyPropertyChanged");
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// Two same-simple-name interfaces declared in DIFFERENT namespaces
    /// disambiguate their explicit event implementations via the clause's
    /// fully namespace-qualified interface type reference — mirroring the
    /// method/property-level fix's namespace-qualification guarantee
    /// exactly, while both implementations keep the exact same plain source
    /// name (<c>Changed</c>).
    /// </summary>
    [Fact]
    public void TwoSameSimpleNameInterfacesFromDifferentNamespaces_ClausesDisambiguate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("NsA.cs", @"
using System;

namespace NsA
{
    public interface IWatcher
    {
        event EventHandler Changed;
    }
}"),
            ("NsB.cs", @"
using System;

namespace NsB
{
    public interface IWatcher
    {
        event EventHandler Changed;
    }
}"),
            ("Both.cs", @"
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
}"),
        });

        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator();
        var translated = project.Documents.Select(document =>
        {
            var documentContext = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit documentUnit = translator.TranslateDocument(document, documentContext);
            return (document, documentContext, documentUnit, printed: GSharpPrinter.Print(documentUnit));
        }).ToArray();
        var target = translated.Single(result => result.document.FilePath == "Both.cs");
        TranslationContext context = target.documentContext;
        CompilationUnit unit = target.documentUnit;
        string printed = target.printed;

        TypeDeclaration both = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Both");
        var events = both.Members.OfType<EventDeclaration>().Where(e => e.Name == "Changed").ToList();

        Assert.Equal(2, events.Count);
        Assert.Contains("(NsA.IWatcher) Changed", printed, StringComparison.Ordinal);
        Assert.Contains("(NsB.IWatcher) Changed", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        foreach (var result in translated)
        {
            RoundTripResult roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                result.printed,
                "Binder.BindGlobalScope cannot resolve qualified interfaces across this multi-package fixture.");
            Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
        }
    }

    /// <summary>
    /// The printer renders the <c>(InterfaceType)</c> clause immediately
    /// after the <c>event</c> keyword, matching the established
    /// method/property/indexer clause rendering convention exactly.
    /// </summary>
    [Fact]
    public void Printer_RendersExplicitInterfaceEventClause()
    {
        (CompilationUnit unit, _) = Translate(@"
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
}");
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("event (IWatcher) Changed", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
