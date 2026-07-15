// <copyright file="Issue2362ExplicitInterfacePropertyTests.cs" company="GSharp">
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
/// Issue #2362: a C# explicit interface PROPERTY implementation (e.g.
/// <c>IAuthorization IProfile.Authorization =&gt; Authorization;</c>) previously
/// translated as an ordinary same-named property, colliding with a same-named
/// public concrete property on the class (GS0102 "'Authorization' is already
/// declared") — the real-world trigger is <c>Oahu.Core/Profile.cs</c>'s
/// <c>Profile</c> class, which has four such properties (<c>Authorization</c>,
/// <c>Token</c>, <c>DeviceInfo</c>, <c>CustomerInfo</c>) all shaped exactly
/// like <see cref="ExactOahuProfileShape_AllFourPropertiesSurvive"/> below.
/// <para>
/// This extends the issue #2010/#2181 explicit-interface-METHOD convention
/// (reserved <c>__explicit_&lt;Interface&gt;__&lt;Member&gt;</c> mangled name +
/// CLR <c>MethodImpl</c> bridge) to properties: a G# USER interface's explicit
/// property implementation is emitted under its own mangled name (so it never
/// collides with the public concrete sibling), and gsc's binder links it to
/// the specific interface property it implements
/// (<c>PropertySymbol.ExplicitInterfaceMember</c>); the emitter binds a CLR
/// <c>MethodImpl</c> row per accessor. An EXTERNAL/BCL interface's explicit
/// property implementation still uses the pre-existing #1911-style
/// forced-public, collision-drop-with-diagnostic fallback (mangling isn't
/// applicable there, exactly like the method case).
/// </para>
/// <para>
/// Indexers cannot be mangled at all (a G# indexer's identity is structurally
/// fixed to <c>this[...]</c>/CLR <c>Item</c>, ADR-0118) — every explicit
/// indexer implementation, user or external, uses the collision-drop
/// fallback; see <see cref="ExplicitIndexerImplementation_CollidesWithPublicIndexer_DropsWithDiagnostic"/>.
/// </para>
/// </summary>
public class Issue2362ExplicitInterfacePropertyTests
{
    /// <summary>
    /// The exact Oahu <c>Profile</c>/<c>IProfile</c> shape (see
    /// <c>src/Oahu.Core/Interfaces.cs</c> and <c>src/Oahu.Core/Profile.cs</c>):
    /// four get-only expression-bodied explicit interface property
    /// implementations, each coexisting with a same-named public concrete
    /// property. All four must survive translation as distinct, mangled,
    /// non-colliding G# properties — this is the primary regression this fix
    /// addresses (previously GS0102 four times over).
    /// </summary>
    [Fact]
    public void ExactOahuProfileShape_AllFourPropertiesSurvive()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public class Authorization { }
    public class Token { }
    public class DeviceInfo { }
    public class CustomerInfo { }

    public interface IProfile
    {
        Authorization Authorization { get; }
        Token Token { get; }
        DeviceInfo DeviceInfo { get; }
        CustomerInfo CustomerInfo { get; }
    }

    public class Profile : IProfile
    {
        public Authorization Authorization { get; set; }
        public Token Token { get; set; }
        public DeviceInfo DeviceInfo { get; set; }
        public CustomerInfo CustomerInfo { get; set; }

        Authorization IProfile.Authorization => Authorization;
        Token IProfile.Token => Token;
        DeviceInfo IProfile.DeviceInfo => DeviceInfo;
        CustomerInfo IProfile.CustomerInfo => CustomerInfo;
    }
}");
        string printed = GSharpPrinter.Print(unit);

        TypeDeclaration profile = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Profile");
        var propertyNames = profile.Members.OfType<PropertyDeclaration>().Select(p => p.Name).ToList();

        Assert.Contains("Authorization", propertyNames);
        Assert.Contains("Token", propertyNames);
        Assert.Contains("DeviceInfo", propertyNames);
        Assert.Contains("CustomerInfo", propertyNames);
        Assert.Contains("__explicit_Corpus_Issue2362_IProfile__Authorization", propertyNames);
        Assert.Contains("__explicit_Corpus_Issue2362_IProfile__Token", propertyNames);
        Assert.Contains("__explicit_Corpus_Issue2362_IProfile__DeviceInfo", propertyNames);
        Assert.Contains("__explicit_Corpus_Issue2362_IProfile__CustomerInfo", propertyNames);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// A single get-only explicit interface property implementation is
    /// mangled and demoted to G# <c>private</c> visibility (matching Roslyn's
    /// own <c>Accessibility.Private</c> for an explicit impl, and C#'s "not
    /// publicly callable by name" semantics) — mirroring the method-level
    /// convention's <c>MapVisibility</c> fallthrough exactly.
    /// </summary>
    [Fact]
    public void SingleExplicitPropertyImplementation_MangledAndPrivate()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public interface IGreeter
    {
        string Greeting { get; }
    }

    public class Host : IGreeter
    {
        string IGreeter.Greeting => ""hi"";
    }
}");
        TypeDeclaration host = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Host");
        PropertyDeclaration prop = host.Members.OfType<PropertyDeclaration>()
            .Single(p => p.Name == "__explicit_Corpus_Issue2362_IGreeter__Greeting");

        Assert.Equal(Visibility.Private, prop.Visibility);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// An explicit property implementation coexisting with a same-signature
    /// public property of the same name no longer collides at all: the
    /// public property keeps its plain name, the explicit implementation
    /// gets its own mangled name — both survive.
    /// </summary>
    [Fact]
    public void ExplicitPropertyImplementationCoexistingWithPublicProperty_BothSurvive()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public interface IGreeter
    {
        string Greeting { get; }
    }

    public class LoudHost : IGreeter
    {
        public string Greeting => ""hello-public"";

        string IGreeter.Greeting => ""hello-explicit"";
    }
}");
        TypeDeclaration loudHost = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "LoudHost");
        var names = loudHost.Members.OfType<PropertyDeclaration>().Select(p => p.Name).ToList();

        Assert.Contains("Greeting", names);
        Assert.Contains("__explicit_Corpus_Issue2362_IGreeter__Greeting", names);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// Two explicit implementations of the SAME-NAME, SAME-SHAPE property
    /// from two DIFFERENT user interfaces (a same-name diamond, no public
    /// sibling) both survive as two distinct mangled-name properties — no
    /// GS0102, no drop, no diagnostic.
    /// </summary>
    [Fact]
    public void TwoCollidingExplicitPropertyImplementations_BothSurviveAsDistinctMangledProperties()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public interface IFoo
    {
        string Value { get; }
    }

    public interface IBar
    {
        string Value { get; }
    }

    public class Multi : IFoo, IBar
    {
        string IFoo.Value => ""foo"";

        string IBar.Value => ""bar"";
    }
}");
        string printed = GSharpPrinter.Print(unit);
        TypeDeclaration multi = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Multi");
        var names = multi.Members.OfType<PropertyDeclaration>().Select(p => p.Name).ToList();

        Assert.Contains("__explicit_Corpus_Issue2362_IFoo__Value", names);
        Assert.Contains("__explicit_Corpus_Issue2362_IBar__Value", names);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// A get/set explicit property implementation preserves BOTH accessors
    /// under the mangled name — an accessor-shape mismatch (only get, or
    /// only set) would break the binder's exact-shape match, so this proves
    /// full get+set fidelity survives translation.
    /// </summary>
    [Fact]
    public void GetSetExplicitPropertyImplementation_PreservesBothAccessors()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public interface ICounter
    {
        int Count { get; set; }
    }

    public class Counter : ICounter
    {
        public int Count { get; set; }

        int ICounter.Count
        {
            get { return Count; }
            set { Count = value; }
        }
    }
}");
        TypeDeclaration counter = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Counter");
        PropertyDeclaration mangled = counter.Members.OfType<PropertyDeclaration>()
            .Single(p => p.Name == "__explicit_Corpus_Issue2362_ICounter__Count");

        Assert.Contains(mangled.Accessors, a => a.Kind == AccessorKind.Get);
        Assert.Contains(mangled.Accessors, a => a.Kind == AccessorKind.Set);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// An explicit property implementation satisfying a member INHERITED
    /// through a derived interface (rather than declared directly on the
    /// interface the class lists) still resolves and mangles correctly —
    /// <c>TryResolveExplicitInterfacePropertyImplementation</c> must walk the
    /// full <c>structSymbol.Interfaces</c> set (which includes every
    /// transitively-required interface, not just the ones written directly
    /// in the class's base-type list), matching the analogous method-level
    /// behavior.
    /// <para>
    /// NOTE: Roslyn's <c>ExplicitInterfaceImplementations</c> can in
    /// principle report MORE than one entry for a single method/property
    /// declaration (see the defensive multi-entry fallback mirrored from
    /// #2010's <c>TranslateMethod</c> onto <c>TranslateProperty</c> below);
    /// no concrete, validly-compiling C# shape that triggers this for either
    /// methods or properties was found during this fix (the pre-existing
    /// method-level branch has never had a triggering repro/test either), so
    /// this test instead exercises the always-Length-1
    /// inherited-interface-property resolution path, which IS reachable and
    /// meaningful.
    /// </para>
    /// </summary>
    [Fact]
    public void ExplicitPropertyImplementationOfInheritedInterfaceMember_ResolvesAndMangles()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public interface IBase
    {
        string Value { get; }
    }

    public interface IDerived : IBase
    {
    }

    public class Impl : IDerived
    {
        string IBase.Value => ""base-value"";
    }
}");
        TypeDeclaration impl = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Impl");
        PropertyDeclaration prop = impl.Members.OfType<PropertyDeclaration>().Single();

        Assert.Equal("__explicit_Corpus_Issue2362_IBase__Value", prop.Name);
        Assert.Equal(Visibility.Private, prop.Visibility);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// An explicit implementation of an EXTERNAL (BCL) interface PROPERTY
    /// still uses the pre-existing #1911-style forced-public,
    /// collision-drop-with-diagnostic fallback: mangling only applies to G#
    /// USER interfaces. Colliding with a same-name/same-shape public property
    /// drops the explicit one with an Unsupported diagnostic.
    /// </summary>
    [Fact]
    public void ExternalInterfaceExplicitPropertyImplementation_CollidesWithPublicProperty_DropsWithDiagnostic()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
using System.ComponentModel;

namespace Corpus.Issue2362
{
    public class Row : IDataErrorInfo
    {
        public string Error => ""public-error"";

        string IDataErrorInfo.Error => Error;

        public string this[string columnName] => """";
    }
}");
        TypeDeclaration row = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Row");
        var names = row.Members.OfType<PropertyDeclaration>().Where(p => !p.IsIndexer).Select(p => p.Name).ToList();

        // Only the surviving (public) property remains — the explicit one
        // was dropped, since mangling never applies to an external interface.
        Assert.Single(names);
        Assert.Equal("Error", names[0]);
        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface property", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// An explicit implementation of an EXTERNAL interface PROPERTY that has
    /// no colliding public sibling survives, forced to G# public visibility
    /// (<see cref="Visibility.Default"/> at class-member position) — the
    /// pre-existing name-based dispatch requires it, exactly like the
    /// method-level #1911 fallback.
    /// </summary>
    [Fact]
    public void ExternalInterfacePropertyImplementation_NoCollision_ForcedPublic()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
using System.ComponentModel;

namespace Corpus.Issue2362
{
    public class Row : IDataErrorInfo
    {
        string IDataErrorInfo.Error => ""only-error"";

        public string this[string columnName] => """";
    }
}");
        TypeDeclaration row = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Row");
        PropertyDeclaration errorProp = row.Members.OfType<PropertyDeclaration>().Single(p => !p.IsIndexer);

        Assert.Equal("Error", errorProp.Name);
        Assert.Equal(Visibility.Default, errorProp.Visibility);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }


    /// <summary>
    /// An explicit interface INDEXER implementation cannot be mangled at all
    /// (G# indexer identity is structurally fixed to <c>this[...]</c>, ADR-0118).
    /// When it collides with a same-shape public indexer, it is dropped with
    /// an Unsupported diagnostic — the collision-drop fallback applies to
    /// indexers regardless of whether the interface is a G# user interface or
    /// external, since mangling is never an option for them.
    /// </summary>
    [Fact]
    public void ExplicitIndexerImplementation_CollidesWithPublicIndexer_DropsWithDiagnostic()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public interface IIndexed
    {
        string this[int i] { get; }
    }

    public class Container : IIndexed
    {
        public string this[int i] => ""public-"" + i;

        string IIndexed.this[int i] => ""explicit-"" + i;
    }
}");
        TypeDeclaration container = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Container");
        var indexers = container.Members.OfType<PropertyDeclaration>().Where(p => p.IsIndexer).ToList();

        // Only the surviving (public) indexer remains — the explicit one was
        // dropped.
        Assert.Single(indexers);
        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("indexer", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// An explicit interface indexer implementation with NO colliding
    /// sibling survives (forced public, since it cannot be mangled).
    /// </summary>
    [Fact]
    public void ExplicitIndexerImplementation_NoCollision_SurvivesForcedPublic()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2362
{
    public interface IIndexed
    {
        string this[int i] { get; }
    }

    public class Container : IIndexed
    {
        string IIndexed.this[int i] => ""value-"" + i;
    }
}");
        TypeDeclaration container = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Container");
        PropertyDeclaration indexer = container.Members.OfType<PropertyDeclaration>().Single(p => p.IsIndexer);

        Assert.Equal(Visibility.Default, indexer.Visibility);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// Two same-simple-name interfaces declared in DIFFERENT namespaces
    /// mangle their explicit property implementations to DISTINCT names
    /// (namespace-qualified, not bare simple name) — mirroring the
    /// method-level fix's namespace-qualification guarantee exactly.
    /// </summary>
    [Fact]
    public void TwoSameSimpleNameInterfacesFromDifferentNamespaces_MangleDistinctly()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("NsA.cs", @"
namespace NsA
{
    public interface IBar
    {
        string V { get; }
    }
}"),
            ("NsB.cs", @"
namespace NsB
{
    public interface IBar
    {
        string V { get; }
    }
}"),
            ("Multi.cs", @"
using NsA;
using NsB;

namespace Corpus.Issue2362
{
    public class Multi : NsA.IBar, NsB.IBar
    {
        string NsA.IBar.V => ""from-a"";

        string NsB.IBar.V => ""from-b"";
    }
}"),
        });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath == "Multi.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        TypeDeclaration multi = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Multi");
        var names = multi.Members.OfType<PropertyDeclaration>().Select(p => p.Name).ToList();

        Assert.Equal(2, names.Distinct(StringComparer.Ordinal).Count());
        Assert.Contains(names, n => n.StartsWith("__explicit_NsA_IBar__V", StringComparison.Ordinal));
        Assert.Contains(names, n => n.StartsWith("__explicit_NsB_IBar__V", StringComparison.Ordinal));
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

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
