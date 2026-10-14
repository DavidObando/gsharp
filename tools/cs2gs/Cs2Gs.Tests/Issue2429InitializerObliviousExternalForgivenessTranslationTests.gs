// <copyright file="Issue2429InitializerObliviousExternalForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #2429: an object/struct-initializer
/// MEMBER VALUE (`Type{Member: expr}` / `Type(args){Member: expr}`)
/// and a COLLECTION-INITIALIZER element/`Add`-argument (bare, keyed, or
/// indexed) did not receive the oblivious EXTERNAL (metadata, no nullable
/// context) null-forgiveness then implemented for a direct RETURN (#2202),
/// an explicit-typed LOCAL declaration's initializer (#2425), and a plain
/// REASSIGNMENT statement (#2427). This is the exact real-world Oahu.Core
/// shape surfaced by #2429:
/// - `AaxExporter.gs:194/202` — `Oahu.Audible.Json.Author{Asin: author.Asin, Name: author.Name}` /
/// `Series{...}`, an object initializer whose member values read an oblivious external
/// `author.Name`/`serbook.SeqString`.
/// - `BookLibrary.gs:124` — `return AccountAliasContext(account.Id, nil, nil){Alias = account.Alias}`,
/// a construction-with-initializer-suffix whose member value is a taint-promoted source member.
/// - `Authorize.gs:228` —
/// `Dictionary[string, string]{ ["source_token"] = profile.Token.RefreshToken, ... }`, an indexed
/// collection-initializer element.
///
/// <b>Fix</b>: a new shared bridge, `ForgiveInitializerElementValue`,
/// checks BOTH signal sources this issue family relies on — the same/sibling-
/// SOURCE whole-program taint fixpoint (`IsNullablePromotedValue`,
/// #1072/#2259/#2412) and an oblivious EXTERNAL member the fixpoint cannot see
/// (`IsObliviousExternalNullableMember`, #2113/#2202/#2425/#2427) —
/// gated on the TARGET position (object/struct-initializer member, indexer
/// value, or resolved `Add` parameter) expecting a genuinely non-null
/// reference (not itself annotated or promoted). `ForgiveObjectInitializerValue`
/// (which previously checked `IsNullablePromotedValue` only) now
/// delegates to the shared bridge, and `TranslateCollectionInitializerElements`
/// (which previously had NO forgiveness at all) routes all three collection-
/// element shapes through it too.
///
/// The oblivious EXTERNAL signal needed `!!` because gsc used to import
/// such a member as `T?` (ADR-0136). Since ADR-0186 step 3 gsc imports it
/// as the platform type `T!` and checks it itself, so the external-member
/// tests now pin that cs2gs emits no `!!` (ADR-0186 step 6, PR 0). A
/// taint-promoted SIBLING-PROJECT source member is still a real `T?` and
/// keeps its `!!`. The test names (`…IsForgiven`) predate ADR-0186
/// step 6 and are kept for issue traceability; the assertions state the
/// current contract.
open class Issue2429InitializerObliviousExternalForgivenessTranslationTests {
    // ---- Object-initializer member value: oblivious EXTERNAL member -------
    @Fact
    func ObjectInitializerLiteral_ExternalInstanceMethodResult_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("Target{Name: ext.Combine(\"hello\")!!}", Compact(printed))
    }

    @Fact
    func ObjectInitializerLiteral_ExternalFieldRead_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Field };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: ext.Field}", Compact(printed))
        Assert.DoesNotContain("Target{Name: ext.Field!!}", Compact(printed))
    }

    @Fact
    func ObjectInitializerLiteral_ExternalPropertyRead_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Prop };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: ext.Prop}", Compact(printed))
        Assert.DoesNotContain("Target{Name: ext.Prop!!}", Compact(printed))
    }

    @Fact
    func ObjectInitializerLiteral_ExternalStaticMethodResult_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make() => new Target { Name = ExtLib.StaticCombine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: ExtLib.StaticCombine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("Target{Name: ExtLib.StaticCombine(\"hello\")!!}", Compact(printed))
    }

    @Fact
    func ObjectInitializerLiteral_ExternalExtensionMethodResult_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(string seed) => new Target { Name = seed.AsUncIfLong() };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: seed.AsUncIfLong()}", Compact(printed))
        Assert.DoesNotContain("Target{Name: seed.AsUncIfLong()!!}", Compact(printed))
    }

    @Fact
    func ObjectInitializerLiteral_FieldTarget_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name;
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("Target{Name: ext.Combine(\"hello\")!!}", Compact(printed))
    }

    @Fact
    func ObjectInitializerLiteral_InitOnlyProperty_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; init; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("Target{Name: ext.Combine(\"hello\")!!}", Compact(printed))
    }

    // ---- Construction-with-initializer-suffix: Type(args){ Member = expr } -
    @Fact
    func ConstructionWithInitializerSuffix_ExternalMemberValue_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public Target(int id) { Id = id; }

        public int Id { get; }

        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target(1) { Name = ext.Combine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target(1){Name = ext.Combine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("Target(1){Name = ext.Combine(\"hello\")!!}", Compact(printed))
    }

    /// The exact real-world `BookLibrary.gs:124` shape: a
    /// construction-with-initializer-suffix return whose member value reads a
    /// SIBLING-SOURCE property (`Account.Alias`, declared in a
    /// referenced project and taint-promoted there by an unrelated
    /// `.IsNullOrWhiteSpace()`/`?.` use) rather than an external
    /// oblivious member — the OTHER signal source
    /// `ForgiveInitializerElementValue` checks.
    ///
    /// The exact real-world `BookLibrary.gs:124` topology: a
    /// construction-with-initializer-suffix return whose member value reads a
    /// SIBLING-PROJECT source property (`Account.Alias`, declared in a
    /// separate compilation and taint-promoted THERE by an unrelated
    /// `?.` use, exactly like the real `Oahu.Data`/`Oahu.Core`
    /// split) rather than an external oblivious member — the OTHER signal
    /// source `ForgiveInitializerElementValue` checks
    /// (`IsNullablePromotedValue`, via the #2412 cross-project
    /// `SiblingCompilations` bridge). Deliberately cross-PROJECT (not
    /// same-file): a same-compilation whole-program fixpoint also propagates
    /// taint FORWARD into an initializer TARGET property assigned from an
    /// already-tainted value, which would promote
    /// `AccountAliasContext.DisplayAlias` too and defeat this specific
    /// test's point — the real Oahu shape (and this test) needs the SOURCE
    /// promoted in ITS OWN project while the TARGET, declared and analyzed in
    /// a DIFFERENT project, stays genuinely non-nullable.
    @Fact
    func ConstructionWithInitializerSuffix_TaintPromotedSiblingProjectMemberValue_IsForgiven() {
        const DataProjectSource = `
namespace Demo.Data
{
    public interface IAliasHolder
    {
        string Alias { get; }
    }

    public class Account : IAliasHolder
    {
        public int Id { get; set; }

        public Account Fallback { get; set; }

        public string Alias => Fallback?.Alias;
    }
}`
        const CoreProjectSource = `
using Demo.Data;

namespace Demo.Core
{
    public class AccountAliasContext
    {
        public AccountAliasContext(int id) { Id = id; }

        public int Id { get; }

        public string DisplayAlias { get; set; }
    }

    public class C
    {
        public AccountAliasContext Make(Account account) =>
            new AccountAliasContext(account.Id) { DisplayAlias = account.Alias };
    }
}`
        let dataProject = LoadObliviousProject(DataProjectSource, "Issue2429DemoData")
        let coreProject = LoadObliviousProject(
            CoreProjectSource,
            "Issue2429DemoCore",
            []MetadataReference{dataProject.Compilation.ToMetadataReference()}
        )
        let siblings = []CSharpCompilation{coreProject.Compilation, dataProject.Compilation}
        let printedCore = TranslateProject(coreProject, siblings)
        Assert.Contains("AccountAliasContext(account.Id){DisplayAlias = account.Alias!!}", Compact(printedCore))
    }

    // ---- Nested initializers -----------------------------------------------
    @Fact
    func NestedObjectInitializer_ExternalMemberValue_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Inner
    {
        public string Name { get; set; }
    }

    public class Outer
    {
        public Inner Nested { get; set; }
    }

    public class C
    {
        public Outer Make(ExtLib ext) => new Outer { Nested = new Inner { Name = ext.Combine("hello") } };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Name: ext.Combine(\"hello\")", Compact(printed))
        Assert.DoesNotContain("Name: ext.Combine(\"hello\")!!", Compact(printed))
    }

    // ---- Collection-initializer elements -----------------------------------
    @Fact
    func CollectionInitializer_BareElement_ExternalMemberValue_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public List<string> Make(ExtLib ext) => new List<string> { ext.Combine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("List[string]{ ext.Combine(\"hello\") }", Compact(printed))
        Assert.DoesNotContain("List[string]{ ext.Combine(\"hello\")!! }", Compact(printed))
    }

    @Fact
    func CollectionInitializer_KeyedElement_ExternalMemberValue_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Dictionary<string, string> Make(ExtLib ext) =>
            new Dictionary<string, string> { { "key", ext.Combine("hello") } };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("ext.Combine(\"hello\")", Compact(printed))
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", Compact(printed))
    }

    /// The exact real-world `Authorize.gs:228` shape: an INDEXED
    /// collection-initializer element (`["k"] = v`) on a
    /// `Dictionary<string, string>`.
    @Fact
    func CollectionInitializer_IndexedElement_ExternalMemberValue_IsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Dictionary<string, string> Make(ExtLib ext) =>
            new Dictionary<string, string> { ["source_token"] = ext.Prop };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("[\"source_token\"] = ext.Prop", Compact(printed))
        Assert.DoesNotContain("[\"source_token\"] = ext.Prop!!", Compact(printed))
    }

    // ---- Negative / scope controls ------------------------------------------
    /// Negative test: an external oblivious method whose declared return is an
    /// UNSUBSTITUTED type parameter (`T Generic<T>(T seed)`) is
    /// excluded by `IsObliviousExternalNullableMember` — the same filter
    /// #2202/#2425/#2427 already rely on — so the initializer member must not
    /// be forgiven.
    @Fact
    func ObjectInitializerLiteral_GenericMethod_UnsubstitutedTypeParameterReturn_IsNotForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Generic("seed") };
    }
}`)
        Assert.Contains("Target{Name: ext.Generic(\"seed\")}", Compact(printed))
    }

    /// Negative/scope control: the TARGET member is already nullable-annotated
    /// (`string?`) and so accepts the oblivious value unchanged —
    /// nothing to forgive.
    @Fact
    func ObjectInitializerLiteral_NullableAnnotatedTargetMember_IsNotForgiven_ScopeControl() {
        let printed = TranslateObliviousWithAnnotatedTargetLibrary(`
namespace Demo
{
#nullable enable
    public class Target
    {
        public string? Name { get; set; }
    }
#nullable disable

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine("hello") };
    }
}`)
        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed)
    }

    /// Negative/scope control: the TARGET member is itself taint-promoted
    /// (accepts `T?` already) — since the target's own type already
    /// widened, forgiving the value would be redundant; the member stays
    /// unforgiven at the assignment (the member's OWN declared type carries the
    /// nullability instead).
    @Fact
    func ObjectInitializerLiteral_AlreadyPromotedTargetMember_IsNotForgiven_ScopeControl() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }

        public string Describe() => Name?.ToUpperInvariant();
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine("hello") };
    }
}`)
        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed)
    }

    /// Negative/scope control: a SAME-PROJECT (source) member RHS that was
    /// never proven taint-promoted must not be touched by this fix — only an
    /// oblivious EXTERNAL member or an actually-promoted source member
    /// qualifies.
    @Fact
    func ObjectInitializerLiteral_UntaintedSameProjectSourceMember_IsNotForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Helper
    {
        public string Get() { return "a"; }
    }

    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(Helper h) => new Target { Name = h.Get() };
    }
}`)
        Assert.Contains("Target{Name: h.Get()}", Compact(printed))
        Assert.DoesNotContain("h.Get()!!", printed)
    }

    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely `string?`-returning method is a
    /// real, deliberate nullability that must be preserved, not papered over
    /// with a blind initializer-member `!!`.
    @Fact
    func ObjectInitializerLiteral_AnnotatedExternalNullableReturn_IsNotForgiven() {
        let printed = TranslateObliviousWithAnnotatedLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(AnnotatedLib lib) => new Target { Name = lib.MaybeNull() };
    }
}`)
        Assert.Contains("Target{Name: lib.MaybeNull()}", Compact(printed))
        Assert.DoesNotContain("lib.MaybeNull()!!", printed)
    }

    /// A nullable-enabled consumer gets the same result: gsc maps the imported
    /// producer's oblivious contract independently of the consumer's nullable
    /// context (formerly to `T?`, now to `T!`), so no `!!` is
    /// emitted.
    @Fact
    func ObjectInitializerLiteral_NullableEnabledConsumer_IsForgiven() {
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed))
        Assert.DoesNotContain("Target{Name: ext.Combine(\"hello\")!!}", Compact(printed))
    }

    /// The same producer-driven rule applies to a collection-initializer
    /// element.
    @Fact
    func CollectionInitializer_NullableEnabledConsumer_IsForgiven() {
        let printed = TranslateEnabledWithObliviousLibrary(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public List<string> Make(ExtLib ext) => new List<string> { ext.Combine("hello") };
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("List[string]{ ext.Combine(\"hello\") }", Compact(printed))
        Assert.DoesNotContain("List[string]{ ext.Combine(\"hello\")!! }", Compact(printed))
    }

    /// Direct-return/object-initializer parity: assigning the identical
    /// oblivious external call to an object-initializer member and returning it
    /// directly agree, and neither needs a `!!` (both used to carry exactly
    /// one).
    @Fact
    func ObjectInitializerMember_MatchesDirectReturnForgivenessCount() {
        let viaInitializer = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine("hello") };
    }
}`)
        let direct = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Make(ExtLib ext) => ext.Combine("hello");
    }
}`)
        let CountForgiveness = func (printed string) int32 {
            return printed.Split("!!").Length - 1
        }
        // ADR-0186 step 6 (PR 0): both shapes still agree. Neither needs a
        // `!!` now: gsc reads the oblivious metadata result as `T!` and
        // checks it at the non-null coercion itself.
        Assert.Equal(0, CountForgiveness(viaInitializer))
        Assert.Equal(0, CountForgiveness(direct))
    }

    // ---- Real-world Oahu.Core shapes ---------------------------------------
    /// The exact real-world `AaxExporter.gs:194`/`:202` shape: a
    /// plain object-initializer literal (no constructor arguments) whose
    /// member values read an oblivious external type's properties
    /// (`author.Asin`/`author.Name`), inside a projection loop.
    @Fact
    func AaxExporterShape_AuthorProjectionLoop_MemberValuesAreForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
using System.Collections.Generic;

namespace Demo
{
    public class Author
    {
        public string Asin { get; set; }

        public string Name { get; set; }
    }

    public class C
    {
        public List<Author> BuildAuthors(List<ExtAuthor> authors)
        {
            var result = new List<Author>();
            foreach (var author in authors)
            {
                var a = new Author { Asin = author.Asin, Name = author.Name };
                result.Add(a);
            }

            return result;
        }
    }
}`, extraLibSource: `
public class ExtAuthor
{
    public string Asin { get; set; }

    public string Name { get; set; }
}
`)
        let compact = Compact(printed)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Author{Asin: author.Asin, Name: author.Name}", compact)
        Assert.DoesNotContain("Author{Asin: author.Asin!!, Name: author.Name!!}", compact)
    }

    /// The exact real-world `Authorize.gs:228` shape: a
    /// `Dictionary<string, string>` initializer with several
    /// indexed elements, one of which reads a nested oblivious external
    /// member chain (`profile.Token.RefreshToken`).
    @Fact
    func AuthorizeShape_TokenRequestDictionary_RefreshTokenElementIsForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Dictionary<string, string> BuildRequest(ExtProfile profile)
        {
            return new Dictionary<string, string>
            {
                ["app_name"] = "Audible",
                ["source_token"] = profile.Token.RefreshToken,
                ["source_token_type"] = "refresh_token",
            };
        }
    }
}`, extraLibSource: `
public class ExtToken
{
    public string RefreshToken { get; set; }
}

public class ExtProfile
{
    public ExtToken Token { get; set; }
}
`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("[\"source_token\"] = profile.Token.RefreshToken", Compact(printed))
        Assert.DoesNotContain("[\"source_token\"] = profile.Token!!.RefreshToken!!", Compact(printed))
    }

    shared {
        // ---- Helpers ------------------------------------------------------------
        /// Compiles a tiny "external" library WITHOUT a nullable context (oblivious),
        /// optionally appending [`extraLibSource`](paramref), then translates
        /// the [`source`](paramref) snippet referencing it in an oblivious
        /// compilation.
        private func TranslateObliviousWithObliviousLibrary(source string, extraLibSource string? = nil) string {
            let libSource = `
public class ExtLib
{
    public string Combine(string separator) { return separator; }

    public string Field;

    public string Prop { get; set; }

    public static string StaticCombine(string separator) { return separator; }

    public T Generic<T>(T seed) { return seed; }
}

public static class ExtLibExtensions
{
    public static string AsUncIfLong(this string path)
    {
        return path;
    }
}
` + extraLibSource
            let libRef = CompileObliviousLibrary(libSource, "Issue2429ObliviousExtLib_" + Guid.NewGuid().ToString("N"))
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2429.ObliviousExternalInitializerInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        /// Same oblivious external library, but the CONSUMING snippet declares its
        /// own initializer target with an explicit nullable-annotated (`#nullable
        /// enable`) member type — used for the already-nullable-target scope
        /// control.
        private func TranslateObliviousWithAnnotatedTargetLibrary(source string) string {
            const LibSource = `
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
`
            let libRef = CompileObliviousLibrary(
                libSource: LibSource,
                assemblyName: "Issue2429ObliviousExtLibForAnnotatedTarget"
            )
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2429.AnnotatedTargetInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        /// Compiles a tiny "external" library WITH nullable annotations enabled (a
        /// genuinely `string?`-returning method), then translates the
        /// [`source`](paramref) snippet referencing it in an oblivious
        /// compilation.
        private func TranslateObliviousWithAnnotatedLibrary(source string) string {
            const LibSource = `
#nullable enable
public class AnnotatedLib
{
    public string? MaybeNull() { return null; }
}
`
            let libRef = CompileAnnotatedLibrary(LibSource, "Issue2429AnnotatedExtLib")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2429.AnnotatedExternalReturnInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        /// Translates the [`source`](paramref) in a nullable-ENABLED compilation
        /// referencing the same oblivious external library — verifies the fix is gated.
        private func TranslateEnabledWithObliviousLibrary(source string) string {
            const LibSource = `
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
`
            let libRef = CompileObliviousLibrary(
                libSource: LibSource,
                assemblyName: "Issue2429ObliviousExtLibForEnabled"
            )
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2429.EnabledCallingObliviousInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func CompileObliviousLibrary(libSource string, assemblyName string) MetadataReference {
            let libTree = CSharpSyntaxTree.ParseText(libSource, CSharpParseOptions(LanguageVersion.Latest))
            let libCompilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{libTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            using let peStream = MemoryStream()
            let emit = libCompilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return MetadataReference.CreateFromStream(peStream)
        }

        private func CompileAnnotatedLibrary(libSource string, assemblyName string) MetadataReference {
            let libTree = CSharpSyntaxTree.ParseText(libSource, CSharpParseOptions(LanguageVersion.Latest))
            let libCompilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{libTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let peStream = MemoryStream()
            let emit = libCompilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return MetadataReference.CreateFromStream(peStream)
        }

        private func LoadObliviousProject(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                references,
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let translator = CSharpToGSharpTranslator()
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations
            )
            let unit = translator.TranslateDocument(document, context)
            return PrintAndValidate(unit)
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Consumer-only fixture omits the referenced C# metadata library from emitted G#."
            )
            Assert.True(result.Success, "Translated G# must round-trip. Errors:\n" + string.Join("\n", result.Errors) + `

Printed:
` + printed)
            return printed
        }

        /// Collapses incidental whitespace/newlines around
        /// composite-literal braces so an assertion is not brittle about the
        /// printer's exact spacing/line-wrapping choices.
        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
