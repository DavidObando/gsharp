// <copyright file="Issue2429InitializerObliviousExternalForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2429: an object/struct-initializer
/// MEMBER VALUE (<c>Type{Member: expr}</c> / <c>Type(args){Member: expr}</c>)
/// and a COLLECTION-INITIALIZER element/<c>Add</c>-argument (bare, keyed, or
/// indexed) do not receive the oblivious EXTERNAL (metadata, no nullable
/// context) null-forgiveness already implemented for a direct RETURN (#2202),
/// an explicit-typed LOCAL declaration's initializer (#2425), and a plain
/// REASSIGNMENT statement (#2427). This is the exact real-world Oahu.Core
/// shape surfaced by #2429:
/// <list type="bullet">
/// <item><c>AaxExporter.gs:194/202</c> — <c>Oahu.Audible.Json.Author{Asin:
/// author.Asin, Name: author.Name}</c> / <c>Series{...}</c>, an object
/// initializer whose member values read an oblivious external
/// <c>author.Name</c>/<c>serbook.SeqString</c>.</item>
/// <item><c>BookLibrary.gs:124</c> — <c>return
/// AccountAliasContext(account.Id, nil, nil){Alias = account.Alias}</c>, a
/// construction-with-initializer-suffix whose member value is a
/// taint-promoted source member.</item>
/// <item><c>Authorize.gs:228</c> — <c>Dictionary[string, string]{
/// ["source_token"] = profile.Token.RefreshToken, ... }</c>, an indexed
/// collection-initializer element.</item>
/// </list>
/// <para>
/// <b>Fix</b>: a new shared bridge, <c>ForgiveInitializerElementValue</c>,
/// checks BOTH signal sources this issue family relies on — the same/sibling-
/// SOURCE whole-program taint fixpoint (<c>IsNullablePromotedValue</c>,
/// #1072/#2259/#2412) and an oblivious EXTERNAL member the fixpoint cannot see
/// (<c>IsObliviousExternalNullableMember</c>, #2113/#2202/#2425/#2427) —
/// gated on the TARGET position (object/struct-initializer member, indexer
/// value, or resolved <c>Add</c> parameter) expecting a genuinely non-null
/// reference (not itself annotated or promoted). <c>ForgiveObjectInitializerValue</c>
/// (which previously checked <c>IsNullablePromotedValue</c> only) now
/// delegates to the shared bridge, and <c>TranslateCollectionInitializerElements</c>
/// (which previously had NO forgiveness at all) routes all three collection-
/// element shapes through it too.
/// </para>
/// </summary>
public class Issue2429InitializerObliviousExternalForgivenessTranslationTests
{
    // ---- Object-initializer member value: oblivious EXTERNAL member -------

    [Fact]
    public void ObjectInitializerLiteral_ExternalInstanceMethodResult_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine(""hello"") };
    }
}");

        Assert.Contains("Target{Name: ext.Combine(\"hello\")!!}", Compact(printed));
    }

    [Fact]
    public void ObjectInitializerLiteral_ExternalFieldRead_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
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
}");

        Assert.Contains("Target{Name: ext.Field!!}", Compact(printed));
    }

    [Fact]
    public void ObjectInitializerLiteral_ExternalPropertyRead_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
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
}");

        Assert.Contains("Target{Name: ext.Prop!!}", Compact(printed));
    }

    [Fact]
    public void ObjectInitializerLiteral_ExternalStaticMethodResult_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make() => new Target { Name = ExtLib.StaticCombine(""hello"") };
    }
}");

        Assert.Contains("Target{Name: ExtLib.StaticCombine(\"hello\")!!}", Compact(printed));
    }

    [Fact]
    public void ObjectInitializerLiteral_ExternalExtensionMethodResult_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
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
}");

        Assert.Contains("Target{Name: seed.AsUncIfLong()!!}", Compact(printed));
    }

    [Fact]
    public void ObjectInitializerLiteral_FieldTarget_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name;
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine(""hello"") };
    }
}");

        Assert.Contains("Target{Name: ext.Combine(\"hello\")!!}", Compact(printed));
    }

    [Fact]
    public void ObjectInitializerLiteral_InitOnlyProperty_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name { get; init; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine(""hello"") };
    }
}");

        Assert.Contains("Target{Name: ext.Combine(\"hello\")!!}", Compact(printed));
    }

    // ---- Construction-with-initializer-suffix: Type(args){ Member = expr } -

    [Fact]
    public void ConstructionWithInitializerSuffix_ExternalMemberValue_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
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
        public Target Make(ExtLib ext) => new Target(1) { Name = ext.Combine(""hello"") };
    }
}");

        Assert.Contains("Target(1){Name = ext.Combine(\"hello\")!!}", Compact(printed));
    }

    /// <summary>
    /// The exact real-world <c>BookLibrary.gs:124</c> shape: a
    /// construction-with-initializer-suffix return whose member value reads a
    /// SIBLING-SOURCE property (<c>Account.Alias</c>, declared in a
    /// referenced project and taint-promoted there by an unrelated
    /// <c>.IsNullOrWhiteSpace()</c>/<c>?.</c> use) rather than an external
    /// oblivious member — the OTHER signal source
    /// <c>ForgiveInitializerElementValue</c> checks.
    /// </summary>
    /// <summary>
    /// The exact real-world <c>BookLibrary.gs:124</c> topology: a
    /// construction-with-initializer-suffix return whose member value reads a
    /// SIBLING-PROJECT source property (<c>Account.Alias</c>, declared in a
    /// separate compilation and taint-promoted THERE by an unrelated
    /// <c>?.</c> use, exactly like the real <c>Oahu.Data</c>/<c>Oahu.Core</c>
    /// split) rather than an external oblivious member — the OTHER signal
    /// source <c>ForgiveInitializerElementValue</c> checks
    /// (<c>IsNullablePromotedValue</c>, via the #2412 cross-project
    /// <c>SiblingCompilations</c> bridge). Deliberately cross-PROJECT (not
    /// same-file): a same-compilation whole-program fixpoint also propagates
    /// taint FORWARD into an initializer TARGET property assigned from an
    /// already-tainted value, which would promote
    /// <c>AccountAliasContext.DisplayAlias</c> too and defeat this specific
    /// test's point — the real Oahu shape (and this test) needs the SOURCE
    /// promoted in ITS OWN project while the TARGET, declared and analyzed in
    /// a DIFFERENT project, stays genuinely non-nullable.
    /// </summary>
    [Fact]
    public void ConstructionWithInitializerSuffix_TaintPromotedSiblingProjectMemberValue_IsForgiven()
    {
        const string DataProjectSource = @"
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
}";

        const string CoreProjectSource = @"
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
}";

        LoadedCSharpProject dataProject = LoadObliviousProject(DataProjectSource, "Issue2429DemoData");
        LoadedCSharpProject coreProject = LoadObliviousProject(
            CoreProjectSource,
            "Issue2429DemoCore",
            new MetadataReference[] { dataProject.Compilation.ToMetadataReference() });

        var siblings = new[] { coreProject.Compilation, dataProject.Compilation };
        string printedCore = TranslateProject(coreProject, siblings);

        Assert.Contains(
            "AccountAliasContext(account.Id){DisplayAlias = account.Alias!!}",
            Compact(printedCore));
    }

    // ---- Nested initializers -----------------------------------------------

    [Fact]
    public void NestedObjectInitializer_ExternalMemberValue_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
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
        public Outer Make(ExtLib ext) => new Outer { Nested = new Inner { Name = ext.Combine(""hello"") } };
    }
}");

        Assert.Contains("Name: ext.Combine(\"hello\")!!", Compact(printed));
    }

    // ---- Collection-initializer elements -----------------------------------

    [Fact]
    public void CollectionInitializer_BareElement_ExternalMemberValue_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public List<string> Make(ExtLib ext) => new List<string> { ext.Combine(""hello"") };
    }
}");

        Assert.Contains("List[string]{ ext.Combine(\"hello\")!! }", Compact(printed));
    }

    [Fact]
    public void CollectionInitializer_KeyedElement_ExternalMemberValue_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Dictionary<string, string> Make(ExtLib ext) =>
            new Dictionary<string, string> { { ""key"", ext.Combine(""hello"") } };
    }
}");

        Assert.Contains("ext.Combine(\"hello\")!!", Compact(printed));
    }

    /// <summary>
    /// The exact real-world <c>Authorize.gs:228</c> shape: an INDEXED
    /// collection-initializer element (<c>["k"] = v</c>) on a
    /// <c>Dictionary&lt;string, string&gt;</c>.
    /// </summary>
    [Fact]
    public void CollectionInitializer_IndexedElement_ExternalMemberValue_IsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Dictionary<string, string> Make(ExtLib ext) =>
            new Dictionary<string, string> { [""source_token""] = ext.Prop };
    }
}");

        Assert.Contains("[\"source_token\"] = ext.Prop!!", Compact(printed));
    }

    // ---- Negative / scope controls ------------------------------------------

    /// <summary>
    /// Negative test: an external oblivious method whose declared return is an
    /// UNSUBSTITUTED type parameter (<c>T Generic&lt;T&gt;(T seed)</c>) is
    /// excluded by <c>IsObliviousExternalNullableMember</c> — the same filter
    /// #2202/#2425/#2427 already rely on — so the initializer member must not
    /// be forgiven.
    /// </summary>
    [Fact]
    public void ObjectInitializerLiteral_GenericMethod_UnsubstitutedTypeParameterReturn_IsNotForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Generic(""seed"") };
    }
}");

        Assert.Contains("Target{Name: ext.Generic(\"seed\")}", Compact(printed));
    }

    /// <summary>
    /// Negative/scope control: the TARGET member is already nullable-annotated
    /// (<c>string?</c>) and so already accepts a <c>T?</c> value unchanged —
    /// nothing to forgive.
    /// </summary>
    [Fact]
    public void ObjectInitializerLiteral_NullableAnnotatedTargetMember_IsNotForgiven_ScopeControl()
    {
        string printed = TranslateObliviousWithAnnotatedTargetLibrary(@"
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
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine(""hello"") };
    }
}");

        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed));
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Negative/scope control: the TARGET member is itself taint-promoted
    /// (accepts <c>T?</c> already) — since the target's own type already
    /// widened, forgiving the value would be redundant; the member stays
    /// unforgiven at the assignment (the member's OWN declared type carries the
    /// nullability instead).
    /// </summary>
    [Fact]
    public void ObjectInitializerLiteral_AlreadyPromotedTargetMember_IsNotForgiven_ScopeControl()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }

        public string Describe() => Name?.ToUpperInvariant();
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine(""hello"") };
    }
}");

        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed));
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Negative/scope control: a SAME-PROJECT (source) member RHS that was
    /// never proven taint-promoted must not be touched by this fix — only an
    /// oblivious EXTERNAL member or an actually-promoted source member
    /// qualifies.
    /// </summary>
    [Fact]
    public void ObjectInitializerLiteral_UntaintedSameProjectSourceMember_IsNotForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Helper
    {
        public string Get() { return ""a""; }
    }

    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(Helper h) => new Target { Name = h.Get() };
    }
}");

        Assert.Contains("Target{Name: h.Get()}", Compact(printed));
        Assert.DoesNotContain("h.Get()!!", printed);
    }

    /// <summary>
    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely <c>string?</c>-returning method is a
    /// real, deliberate nullability that must be preserved, not papered over
    /// with a blind initializer-member <c>!!</c>.
    /// </summary>
    [Fact]
    public void ObjectInitializerLiteral_AnnotatedExternalNullableReturn_IsNotForgiven()
    {
        string printed = TranslateObliviousWithAnnotatedLibrary(@"
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
}");

        Assert.Contains("Target{Name: lib.MaybeNull()}", Compact(printed));
        Assert.DoesNotContain("lib.MaybeNull()!!", printed);
    }

    /// <summary>
    /// Negative test: a nullable-ENABLED compilation constructing the same
    /// object initializer from the same oblivious external member — the fix
    /// is gated to oblivious compilations only (its own nullable flow analysis
    /// is authoritative), so no <c>!!</c> is inserted.
    /// </summary>
    [Fact]
    public void ObjectInitializerLiteral_NullableEnabledCompilation_IsNotForgiven()
    {
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine(""hello"") };
    }
}");

        Assert.Contains("Target{Name: ext.Combine(\"hello\")}", Compact(printed));
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Negative/scope control: same nullable-enabled gate, applied to a
    /// collection-initializer element instead of an object-initializer
    /// member.
    /// </summary>
    [Fact]
    public void CollectionInitializer_NullableEnabledCompilation_IsNotForgiven()
    {
        string printed = TranslateEnabledWithObliviousLibrary(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public List<string> Make(ExtLib ext) => new List<string> { ext.Combine(""hello"") };
    }
}");

        Assert.Contains("List[string]{ ext.Combine(\"hello\") }", Compact(printed));
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Direct-return/object-initializer parity: assigning the identical
    /// oblivious external call to an object-initializer member gets exactly
    /// the same single <c>!!</c> a direct return of that call would.
    /// </summary>
    [Fact]
    public void ObjectInitializerMember_MatchesDirectReturnForgivenessCount()
    {
        string viaInitializer = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class C
    {
        public Target Make(ExtLib ext) => new Target { Name = ext.Combine(""hello"") };
    }
}");

        string direct = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Make(ExtLib ext) => ext.Combine(""hello"");
    }
}");

        int CountForgiveness(string printed) => printed.Split("!!").Length - 1;

        Assert.Equal(1, CountForgiveness(viaInitializer));
        Assert.Equal(1, CountForgiveness(direct));
    }

    // ---- Real-world Oahu.Core shapes ---------------------------------------

    /// <summary>
    /// The exact real-world <c>AaxExporter.gs:194</c>/<c>:202</c> shape: a
    /// plain object-initializer literal (no constructor arguments) whose
    /// member values read an oblivious external type's properties
    /// (<c>author.Asin</c>/<c>author.Name</c>), inside a projection loop.
    /// </summary>
    [Fact]
    public void AaxExporterShape_AuthorProjectionLoop_MemberValuesAreForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
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
}",
            extraLibSource: @"
public class ExtAuthor
{
    public string Asin { get; set; }

    public string Name { get; set; }
}
");

        string compact = Compact(printed);
        Assert.Contains("Author{Asin: author.Asin!!, Name: author.Name!!}", compact);
    }

    /// <summary>
    /// The exact real-world <c>Authorize.gs:228</c> shape: a
    /// <c>Dictionary&lt;string, string&gt;</c> initializer with several
    /// indexed elements, one of which reads a nested oblivious external
    /// member chain (<c>profile.Token.RefreshToken</c>).
    /// </summary>
    [Fact]
    public void AuthorizeShape_TokenRequestDictionary_RefreshTokenElementIsForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Dictionary<string, string> BuildRequest(ExtProfile profile)
        {
            return new Dictionary<string, string>
            {
                [""app_name""] = ""Audible"",
                [""source_token""] = profile.Token.RefreshToken,
                [""source_token_type""] = ""refresh_token"",
            };
        }
    }
}",
            extraLibSource: @"
public class ExtToken
{
    public string RefreshToken { get; set; }
}

public class ExtProfile
{
    public ExtToken Token { get; set; }
}
");

        Assert.Contains("[\"source_token\"] = profile.Token!!.RefreshToken!!", Compact(printed));
    }

    // ---- Helpers ------------------------------------------------------------

    /// <summary>
    /// Compiles a tiny "external" library WITHOUT a nullable context (oblivious),
    /// optionally appending <paramref name="extraLibSource"/>, then translates
    /// the <paramref name="source"/> snippet referencing it in an oblivious
    /// compilation.
    /// </summary>
    private static string TranslateObliviousWithObliviousLibrary(string source, string extraLibSource = null)
    {
        string libSource = @"
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
" + extraLibSource;

        MetadataReference libRef = CompileObliviousLibrary(libSource, "Issue2429ObliviousExtLib_" + Guid.NewGuid().ToString("N"));

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2429.ObliviousExternalInitializerInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    /// <summary>
    /// Same oblivious external library, but the CONSUMING snippet declares its
    /// own initializer target with an explicit nullable-annotated (`#nullable
    /// enable`) member type — used for the already-nullable-target scope
    /// control.
    /// </summary>
    private static string TranslateObliviousWithAnnotatedTargetLibrary(string source)
    {
        const string LibSource = @"
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
";
        MetadataReference libRef = CompileObliviousLibrary(libSource: LibSource, assemblyName: "Issue2429ObliviousExtLibForAnnotatedTarget");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2429.AnnotatedTargetInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    /// <summary>
    /// Compiles a tiny "external" library WITH nullable annotations enabled (a
    /// genuinely <c>string?</c>-returning method), then translates the
    /// <paramref name="source"/> snippet referencing it in an oblivious
    /// compilation.
    /// </summary>
    private static string TranslateObliviousWithAnnotatedLibrary(string source)
    {
        const string LibSource = @"
#nullable enable
public class AnnotatedLib
{
    public string? MaybeNull() { return null; }
}
";
        MetadataReference libRef = CompileAnnotatedLibrary(LibSource, "Issue2429AnnotatedExtLib");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2429.AnnotatedExternalReturnInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    /// <summary>
    /// Translates the <paramref name="source"/> in a nullable-ENABLED compilation
    /// referencing the same oblivious external library — verifies the fix is gated.
    /// </summary>
    private static string TranslateEnabledWithObliviousLibrary(string source)
    {
        const string LibSource = @"
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
";
        MetadataReference libRef = CompileObliviousLibrary(libSource: LibSource, assemblyName: "Issue2429ObliviousExtLibForEnabled");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2429.EnabledCallingObliviousInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static MetadataReference CompileObliviousLibrary(string libSource, string assemblyName)
    {
        var libTree = CSharpSyntaxTree.ParseText(
            libSource,
            new CSharpParseOptions(LanguageVersion.Latest));
        var libCompilation = CSharpCompilation.Create(
            assemblyName,
            new[] { libTree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));
        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = libCompilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        return MetadataReference.CreateFromStream(peStream);
    }

    private static MetadataReference CompileAnnotatedLibrary(string libSource, string assemblyName)
    {
        var libTree = CSharpSyntaxTree.ParseText(
            libSource,
            new CSharpParseOptions(LanguageVersion.Latest));
        var libCompilation = CSharpCompilation.Create(
            assemblyName,
            new[] { libTree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = libCompilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        return MetadataReference.CreateFromStream(peStream);
    }

    private static LoadedCSharpProject LoadObliviousProject(
        string source, string assemblyName, IReadOnlyList<MetadataReference> extraReferences = null)
    {
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (assemblyName + ".cs", source) }, references, assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        return project;
    }

    private static string TranslateProject(
        LoadedCSharpProject project, IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation, document.SemanticModel, document.FilePath, siblingCompilations);
        CompilationUnit unit = translator.TranslateDocument(document, context);
        return PrintAndValidate(unit);
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>Collapses incidental whitespace/newlines around
    /// composite-literal braces so an assertion is not brittle about the
    /// printer's exact spacing/line-wrapping choices.</summary>
    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
}
