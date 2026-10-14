// <copyright file="Issue2362ExplicitInterfacePropertyTests.cs" company="GSharp">
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

/// Issue #2362: a C# explicit interface PROPERTY implementation (e.g.
/// `IAuthorization IProfile.Authorization => Authorization;`) previously
/// translated as an ordinary same-named property, colliding with a same-named
/// public concrete property on the class (GS0102 "'Authorization' is already
/// declared") — the real-world trigger is `Oahu.Core/Profile.cs`'s
/// `Profile` class, which has four such properties (`Authorization`,
/// `Token`, `DeviceInfo`, `CustomerInfo`) all shaped exactly
/// like (cref:ExactOahuProfileShape_AllFourPropertiesSurvive) below.
///
/// This originally extended the issue #2010/#2181 explicit-interface-METHOD
/// convention (reserved `__explicit_<Interface>__<Member>`
/// mangled name + CLR `MethodImpl` bridge) to properties. The ADR-0149
/// redesign replaces the mangled name with a first-class explicit-interface
/// qualifier clause: an explicit property implementation
/// is emitted under its own PLAIN source name carrying a
/// `(InterfaceType)` clause immediately after the `prop` keyword
/// (e.g. `prop (IProfile) Authorization Authorization`), so it never
/// collides with the public concrete sibling (disambiguated by the clause,
/// not by name); gsc's binder resolves the clause's interface type directly
/// and links it to the specific interface property it implements
/// (`PropertySymbol.ExplicitInterfaceClauseTarget`); the emitter binds a
/// CLR `MethodImpl` row per accessor. Issue #3535 extends the same path
/// to imported CLR interfaces.
///
/// Indexers now use the SAME clause-based convention as properties: an
/// explicit indexer implementation is emitted under its own
/// plain source form (`this[...]`) carrying a `(InterfaceType)`
/// clause immediately after the `prop` keyword, since G# interfaces can
/// now declare an indexer member (`prop this[...] T` is no longer
/// rejected inside an `interface` block — a prerequisite gsc binder fix
/// landed alongside this translator change). Imported CLR indexers use the
/// same clause and reflected-slot emitter path; see
/// (cref:ExternalInterfaceExplicitPropertyImplementation_CollidesWithPublicProperty_BothSurvive)
/// for the property-level equivalent and
/// (cref:ExplicitIndexerImplementation_UserInterface_CollidesWithPublicIndexer_BothSurviveWithDistinctClauses)
/// below for the indexer-level clause-based coexistence case.
open class Issue2362ExplicitInterfacePropertyTests {
    /// The exact Oahu `Profile`/`IProfile` shape (see
    /// `src/Oahu.Core/Interfaces.cs` and `src/Oahu.Core/Profile.cs`):
    /// four get-only expression-bodied explicit interface property
    /// implementations, each coexisting with a same-named public concrete
    /// property. All four must survive translation as distinct, clause-
    /// qualified, non-colliding G# properties — this is the primary
    /// regression this fix addresses (previously GS0102 four times over).
    @Fact
    func ExactOahuProfileShape_AllFourPropertiesSurvive() {
        let (unit, context) = Translate(`
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
}`)
        let printed = GSharpPrinter.Print(unit)
        let profile = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Profile")
        let properties = profile.Members.OfType[PropertyDeclaration]().ToList()
        // Every property keeps its own plain source name — four PUBLIC
        // (no clause) and four EXPLICIT (clause-qualified) entries sharing
        // the same four names.
        for name in[]string{"Authorization", "Token", "DeviceInfo", "CustomerInfo"} {
            let withName = properties.Where((p PropertyDeclaration) -> p.Name == name).ToList()
            Assert.Equal(2, withName.Count)
            Assert.Contains(withName, (p PropertyDeclaration) -> p.ExplicitInterfaceType == nil)
            Assert.Contains(
                withName,
                (p PropertyDeclaration) -> p.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IProfile"
            )
        }
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(printed)
    }

    /// A single get-only explicit interface property implementation carries
    /// the ADR-0149 clause and is demoted to G# `private` visibility
    /// (matching Roslyn's own `Accessibility.Private` for an explicit
    /// impl, and C#'s "not publicly callable by name" semantics) — mirroring
    /// the method-level convention's `MapVisibility` fallthrough
    /// exactly.
    @Fact
    func SingleExplicitPropertyImplementation_ClauseQualifiedAndPrivate() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2362
{
    public interface IGreeter
    {
        string Greeting { get; }
    }

    public class Host : IGreeter
    {
        string IGreeter.Greeting => "hi";
    }
}`)
        let host = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Host")
        let prop = host
            .Members
            .OfType[PropertyDeclaration]()
            .Single((p PropertyDeclaration) -> p.Name == "Greeting" && p.ExplicitInterfaceType != nil)
        Assert.Equal(Visibility.Private, prop.Visibility)
        Assert.True(prop.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IGreeter")
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An explicit property implementation coexisting with a same-signature
    /// public property of the same name no longer collides at all: the
    /// public property keeps its plain name with no clause, the explicit
    /// implementation gets its own explicit-interface qualifier clause —
    /// both survive.
    @Fact
    func ExplicitPropertyImplementationCoexistingWithPublicProperty_BothSurvive() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2362
{
    public interface IGreeter
    {
        string Greeting { get; }
    }

    public class LoudHost : IGreeter
    {
        public string Greeting => "hello-public";

        string IGreeter.Greeting => "hello-explicit";
    }
}`)
        let loudHost = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "LoudHost")
        let greetings = loudHost
            .Members
            .OfType[PropertyDeclaration]()
            .Where((p PropertyDeclaration) -> p.Name == "Greeting")
            .ToList()
        Assert.Equal(2, greetings.Count)
        Assert.Contains(greetings, (p PropertyDeclaration) -> p.ExplicitInterfaceType == nil)
        Assert.Contains(
            greetings,
            (p PropertyDeclaration) -> p.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IGreeter"
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// Two explicit implementations of the SAME-NAME, SAME-SHAPE property
    /// from two DIFFERENT user interfaces (a same-name diamond, no public
    /// sibling) both survive as two distinct clause-qualified properties
    /// sharing the same plain source name — no GS0102, no drop, no
    /// diagnostic.
    @Fact
    func TwoCollidingExplicitPropertyImplementations_BothSurviveWithDistinctClauses() {
        let (unit, context) = Translate(`
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
        string IFoo.Value => "foo";

        string IBar.Value => "bar";
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        let multi = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Multi")
        let values = multi
            .Members
            .OfType[PropertyDeclaration]()
            .Where((p PropertyDeclaration) -> p.Name == "Value")
            .ToList()
        Assert.Equal(2, values.Count)
        Assert.Contains(
            values,
            (p PropertyDeclaration) -> p.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IFoo"
        )
        Assert.Contains(
            values,
            (p PropertyDeclaration) -> p.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IBar"
        )
        Assert.Contains("(IFoo) Value", printed, StringComparison.Ordinal)
        Assert.Contains("(IBar) Value", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(printed)
    }

    @Fact
    func Issue3535_ExternalInterfacesWithDifferentMemberTypes_AllExplicitMembersSurvive() {
        let (unit, context) = Translate(`
using System;
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue3535
{
    public abstract class DualMap : IDictionary<int, int>, IReadOnlyDictionary<string, string>
    {
        ICollection<int> IDictionary<int, int>.Keys => throw new NotImplementedException();
        ICollection<int> IDictionary<int, int>.Values => throw new NotImplementedException();
        IEnumerable<string> IReadOnlyDictionary<string, string>.Keys => throw new NotImplementedException();
        IEnumerable<string> IReadOnlyDictionary<string, string>.Values => throw new NotImplementedException();
        int ICollection<KeyValuePair<int, int>>.Count => 1;
        int IReadOnlyCollection<KeyValuePair<string, string>>.Count => 2;
        bool ICollection<KeyValuePair<int, int>>.IsReadOnly => true;
        int IDictionary<int, int>.this[int key] { get => 3; set { } }
        string IReadOnlyDictionary<string, string>.this[string key] => "four";
        void IDictionary<int, int>.Add(int key, int value) => throw new NotImplementedException();
        void ICollection<KeyValuePair<int, int>>.Add(KeyValuePair<int, int> item) => throw new NotImplementedException();
        void ICollection<KeyValuePair<int, int>>.Clear() => throw new NotImplementedException();
        bool ICollection<KeyValuePair<int, int>>.Contains(KeyValuePair<int, int> item) => throw new NotImplementedException();
        bool IDictionary<int, int>.ContainsKey(int key) => throw new NotImplementedException();
        bool IReadOnlyDictionary<string, string>.ContainsKey(string key) => throw new NotImplementedException();
        void ICollection<KeyValuePair<int, int>>.CopyTo(KeyValuePair<int, int>[] array, int arrayIndex) => throw new NotImplementedException();
        bool IDictionary<int, int>.Remove(int key) => throw new NotImplementedException();
        bool ICollection<KeyValuePair<int, int>>.Remove(KeyValuePair<int, int> item) => throw new NotImplementedException();
        bool IDictionary<int, int>.TryGetValue(int key, out int value) => throw new NotImplementedException();
        bool IReadOnlyDictionary<string, string>.TryGetValue(string key, out string value) => throw new NotImplementedException();
        IEnumerator<KeyValuePair<int, int>> IEnumerable<KeyValuePair<int, int>>.GetEnumerator() => throw new NotImplementedException();
        IEnumerator<KeyValuePair<string, string>> IEnumerable<KeyValuePair<string, string>>.GetEnumerator() => throw new NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => throw new NotImplementedException();
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        let dualMap = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "DualMap")
        let properties = dualMap.Members.OfType[PropertyDeclaration]().ToList()
        Assert.Equal(2, properties.Count((p PropertyDeclaration) -> p.Name == "Keys"))
        Assert.Equal(2, properties.Count((p PropertyDeclaration) -> p.Name == "Values"))
        Assert.Equal(2, properties.Count((p PropertyDeclaration) -> p.Name == "Count"))
        Assert.Equal(2, properties.Count((p PropertyDeclaration) -> p.IsIndexer))
        Assert.All(properties, (p PropertyDeclaration) -> Assert.NotNull(p.ExplicitInterfaceType))
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(printed)
    }

    /// A get/set explicit property implementation preserves BOTH accessors
    /// under its clause-qualified declaration — an accessor-shape mismatch
    /// (only get, or only set) would break the binder's exact-shape match,
    /// so this proves full get+set fidelity survives translation.
    @Fact
    func GetSetExplicitPropertyImplementation_PreservesBothAccessors() {
        let (unit, context) = Translate(`
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
}`)
        let counter = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Counter")
        let clauseQualified = counter
            .Members
            .OfType[PropertyDeclaration]()
            .Single((p PropertyDeclaration) -> p.Name == "Count" && p.ExplicitInterfaceType != nil)
        Assert.Contains(clauseQualified.Accessors, (a PropertyAccessor) -> a.Kind == AccessorKind.Get)
        Assert.Contains(clauseQualified.Accessors, (a PropertyAccessor) -> a.Kind == AccessorKind.Set)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An explicit property implementation satisfying a member INHERITED
    /// through a derived interface (rather than declared directly on the
    /// interface the class lists) still resolves and carries the correct
    /// clause — `TryResolveExplicitInterfacePropertyImplementation`
    /// must walk the full `structSymbol.Interfaces` set (which includes
    /// every transitively-required interface, not just the ones written
    /// directly in the class's base-type list), matching the analogous
    /// method-level behavior.
    ///
    /// NOTE: Roslyn's `ExplicitInterfaceImplementations` can in
    /// principle report MORE than one entry for a single method/property
    /// declaration (see the defensive multi-entry fallback mirrored from
    /// #2010's `TranslateMethod` onto `TranslateProperty` below);
    /// no concrete, validly-compiling C# shape that triggers this for either
    /// methods or properties was found during this fix (the pre-existing
    /// method-level branch has never had a triggering repro/test either), so
    /// this test instead exercises the always-Length-1
    /// inherited-interface-property resolution path, which IS reachable and
    /// meaningful.
    @Fact
    func ExplicitPropertyImplementationOfInheritedInterfaceMember_ResolvesAndCarriesClause() {
        let (unit, context) = Translate(`
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
        string IBase.Value => "base-value";
    }
}`)
        let impl = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Impl")
        let prop = impl.Members.OfType[PropertyDeclaration]().Single()
        Assert.Equal("Value", prop.Name)
        Assert.True(prop.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IBase")
        Assert.Equal(Visibility.Private, prop.Visibility)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An explicit implementation of an EXTERNAL (BCL) interface property
    /// uses the same ADR-0149 clause as a source interface, so a colliding
    /// public property and the explicit slot both survive.
    @Fact
    func ExternalInterfaceExplicitPropertyImplementation_CollidesWithPublicProperty_BothSurvive() {
        let (unit, context) = Translate(`
using System.ComponentModel;

namespace Corpus.Issue2362
{
    public class Row : IDataErrorInfo
    {
        public string Error => "public-error";

        string IDataErrorInfo.Error => Error;

        public string this[string columnName] => "";
    }
}`)
        let row = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Row")
        let properties = row
            .Members
            .OfType[PropertyDeclaration]()
            .Where((p PropertyDeclaration) -> !p.IsIndexer)
            .ToList()
        Assert.Equal(2, properties.Count)
        Assert.Contains(properties, (p PropertyDeclaration) -> p.ExplicitInterfaceType == nil)
        Assert.Contains(
            properties,
            (p PropertyDeclaration) -> p.ExplicitInterfaceType is NamedTypeReference n &&
                n.Name == "IDataErrorInfo" &&
                p.Visibility == Visibility.Private
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An explicit implementation of an EXTERNAL interface property with no
    /// colliding sibling is still clause-qualified and private.
    @Fact
    func ExternalInterfacePropertyImplementation_NoCollision_ClauseQualifiedAndPrivate() {
        let (unit, context) = Translate(`
using System.ComponentModel;

namespace Corpus.Issue2362
{
    public class Row : IDataErrorInfo
    {
        string IDataErrorInfo.Error => "only-error";

        public string this[string columnName] => "";
    }
}`)
        let row = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Row")
        let errorProp = row.Members.OfType[PropertyDeclaration]().Single((p PropertyDeclaration) -> !p.IsIndexer)
        Assert.Equal("Error", errorProp.Name)
        Assert.Equal(Visibility.Private, errorProp.Visibility)
        Assert.True(errorProp.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IDataErrorInfo")
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An explicit interface INDEXER implementation cannot use the ADR-0149
    /// clause today (G# interfaces cannot declare indexer members — a
    /// separate, pre-existing gsc limitation). When it collides with a
    /// same-shape public indexer, it is dropped with an Unsupported
    /// diagnostic — the collision-drop fallback applies to indexers
    /// regardless of whether the interface is a G# user interface or
    /// external, since the clause is never resolvable for them.
    @Fact
    func ExplicitIndexerImplementation_UserInterface_CollidesWithPublicIndexer_BothSurviveWithDistinctClauses() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2362
{
    public interface IIndexed
    {
        string this[int i] { get; }
    }

    public class Container : IIndexed
    {
        public string this[int i] => "public-" + i;

        string IIndexed.this[int i] => "explicit-" + i;
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        let container = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Container")
        let indexers = container
            .Members
            .OfType[PropertyDeclaration]()
            .Where((p PropertyDeclaration) -> p.IsIndexer)
            .ToList()
        // Both the public and the explicit indexer survive — the G# USER
        // interface IIndexed lets the explicit one resolve via the
        // `(IIndexed)` clause instead of colliding/dropping.
        Assert.Equal(2, indexers.Count)
        Assert.Contains(
            indexers,
            (p PropertyDeclaration) -> p.ExplicitInterfaceType == nil && p.Visibility == Visibility.Default
        )
        Assert.Contains(
            indexers,
            (p PropertyDeclaration) -> p.ExplicitInterfaceType is NamedTypeReference n &&
                n.Name == "IIndexed" &&
                p.Visibility == Visibility.Private
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(printed)
    }

    /// An explicit interface indexer implementation with NO colliding
    /// sibling still resolves via the clause against the G# USER interface
    /// (rather than the older forced-public/no-clause fallback, which only
    /// applies to EXTERNAL/BCL interfaces).
    @Fact
    func ExplicitIndexerImplementation_UserInterface_NoCollision_ClauseQualifiedAndPrivate() {
        let (unit, context) = Translate(`
namespace Corpus.Issue2362
{
    public interface IIndexed
    {
        string this[int i] { get; }
    }

    public class Container : IIndexed
    {
        string IIndexed.this[int i] => "value-" + i;
    }
}`)
        let container = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Container")
        let indexer = container.Members.OfType[PropertyDeclaration]().Single((p PropertyDeclaration) -> p.IsIndexer)
        Assert.Equal(Visibility.Private, indexer.Visibility)
        Assert.True(indexer.ExplicitInterfaceType is NamedTypeReference n && n.Name == "IIndexed")
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An EXTERNAL/BCL explicit indexer uses the ADR-0149 clause and coexists
    /// with a same-shaped public indexer.
    @Fact
    func ExplicitIndexerImplementation_ExternalInterface_CollidesWithPublicIndexer_BothSurvive() {
        let (unit, context) = Translate(`
using System.ComponentModel;

namespace Corpus.Issue2362
{
    public class Row : IDataErrorInfo
    {
        public string Error => "";

        public string this[string columnName] => "public-" + columnName;

        string IDataErrorInfo.this[string columnName] => "explicit-" + columnName;
    }
}`)
        let row = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Row")
        let indexers = row.Members.OfType[PropertyDeclaration]().Where((p PropertyDeclaration) -> p.IsIndexer).ToList()
        Assert.Equal(2, indexers.Count)
        Assert.Contains(indexers, (p PropertyDeclaration) -> p.ExplicitInterfaceType == nil)
        Assert.Contains(
            indexers,
            (p PropertyDeclaration) -> p.ExplicitInterfaceType is NamedTypeReference n &&
                n.Name == "IDataErrorInfo" &&
                p.Visibility == Visibility.Private
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// Two same-simple-name interfaces declared in DIFFERENT namespaces
    /// disambiguate their explicit property implementations via the
    /// clause's fully namespace-qualified interface type reference (e.g.
    /// `(NsA.IBar)` vs. `(NsB.IBar)`) — mirroring the method-level
    /// fix's namespace-qualification guarantee exactly, while both
    /// implementations keep the exact same plain source name (`V`).
    @Fact
    func TwoSameSimpleNameInterfacesFromDifferentNamespaces_ClausesDisambiguate() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("NsA.cs", `
namespace NsA
{
    public interface IBar
    {
        string V { get; }
    }
}`), ("NsB.cs", `
namespace NsB
{
    public interface IBar
    {
        string V { get; }
    }
}`), ("Multi.cs", `
using NsA;
using NsB;

namespace Corpus.Issue2362
{
    public class Multi : NsA.IBar, NsB.IBar
    {
        string NsA.IBar.V => "from-a";

        string NsB.IBar.V => "from-b";
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
        let vProps = multi
            .Members
            .OfType[PropertyDeclaration]()
            .Where((p PropertyDeclaration) -> p.Name == "V")
            .ToList()
        Assert.Equal(2, vProps.Count)
        Assert.Contains("(NsA.IBar) V", printed, StringComparison.Ordinal)
        Assert.Contains("(NsB.IBar) V", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
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
