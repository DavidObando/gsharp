// <copyright file="Issue2455CompositeTypeCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2455: two sibling packages independently declare a same-simple-name
/// top-level type (the exact Oahu shape: <c>Oahu.Audible.Json.ChapterInfo</c>
/// with <c>Chapters []Chapter</c>, and <c>Oahu.BooksDatabase.ChapterInfo</c>
/// with a structurally incompatible <c>Chapters</c> member). A THIRD,
/// unrelated package referencing the bare simple name <c>ChapterInfo</c> —
/// whether as a composite-literal's own type, a field/property/constructor-
/// parameter declared type, or an array/generic element type — got whichever
/// package's declaration happened to occupy
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundScope.TryDeclareTypeAlias(string, GSharp.Core.CodeAnalysis.Symbols.TypeSymbol, string)"/>'s
/// "first declared wins" plain simple-name key — an accident of syntax-tree
/// array order, NOT the reference's actual meaning. Once the wrong candidate
/// won the race, a later composite-literal member (or a genuinely-typed
/// composite literal assigned to that member) was checked against the WRONG
/// type's shape, misfiring <c>GS0490</c> (<c>StructuralProjectionFailure</c>)
/// or silently accepting a member that should not exist on it.
/// <para>
/// The fix (<see cref="GSharp.Core.CodeAnalysis.Binding.BoundScope.TryLookupTypeAlias(string, int, out GSharp.Core.CodeAnalysis.Symbols.TypeSymbol, out bool)"/>)
/// consults the compilation-wide <c>import</c> set (imports are bound
/// compilation-wide — see the Issue #2394 binder remarks) to deterministically
/// resolve the collision: if exactly one of the colliding packages is
/// imported ANYWHERE in the compilation, that package's declaration is the
/// only one a reference could plausibly mean, and it now wins regardless of
/// declaration order. If two or more colliding packages are each imported,
/// resolution is genuinely ambiguous and reports the new <c>GS0496</c>
/// (<c>AmbiguousSourceType</c>) diagnostic instead of silently picking either
/// one. When NEITHER colliding package is imported anywhere (no signal to
/// disambiguate with), the pre-existing "first declared wins" fallback is
/// preserved unchanged — see
/// <see cref="AbsentDisambiguatingImport_PreservesLegacyOrderDependentFallback_DocumentedNotFixed"/>
/// for why this residual case is a documented, deliberately out-of-scope
/// follow-up rather than something this fix silently changes.
/// </para>
/// This does not special-case <c>ChapterInfo</c> anywhere; the fix operates
/// purely on package identity and import visibility, so it fires for ANY
/// same-simple-name source-type collision.
/// </summary>
public class Issue2455CompositeTypeCollisionTests
{
    private const string AudibleChapterInfo = """
        package Oahu.Audible.Json

        class ChapterInfo {
            prop Chapters []Chapter
        }

        class Chapter {
            prop Title string
        }
        """;

    private const string BooksDatabaseChapterInfo = """
        package Oahu.BooksDatabase
        import System.Collections.Generic

        class ChapterInfo {
            prop Chapters ICollection[Chapter]
        }

        class Chapter {
            prop Name string
        }
        """;

    // ---- Exact Oahu issue shape: ContentMetadata{ChapterInfo: ci, ...} ----

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ExactIssueShape_AaxExporterAssignsAudibleChapterInfo_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        // ContentMetadata.ChapterInfo is declared with the BARE simple name,
        // in a package that imports ONLY Oahu.Audible.Json (mirroring the
        // real AaxExporter, which constructs `ci` from the Audible DTO).
        // Regardless of which sibling package's ChapterInfo was declared
        // FIRST across the syntax-tree array, the field's true identity must
        // resolve to Oahu.Audible.Json.ChapterInfo, and the composite literal
        // assignment `ContentMetadata{ChapterInfo: ci, ...}` must bind clean
        // (no GS0490, no GS0496, no GS0157).
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json

            class ContentMetadata {
                prop ChapterInfo ChapterInfo
                prop Title string
            }
            """;

        const string aaxExporter = """
            package Oahu.Core
            import Oahu.Audible.Json

            class AaxExporter {
                func Export(ci ChapterInfo) ContentMetadata {
                    return ContentMetadata{ChapterInfo: ci, Title: "t"}
                }
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata, aaxExporter }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata, aaxExporter };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ExactIssueShape_BothSiblingPackagesImported_ReportsAmbiguousSourceType_NotFalsePositiveGS0490(bool audibleTreeFirst)
    {
        // Negative ambiguity control: when the consuming package imports BOTH
        // colliding sibling packages, `ChapterInfo`'s identity is genuinely
        // undeterminable from the bare reference alone. This must surface the
        // dedicated GS0496 ambiguity diagnostic — never silently resolve to
        // either package's type, and never misreport the unrelated GS0490
        // structural-projection diagnostic (which would blame the composite
        // literal's field values for what is really a type-identity problem).
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.BooksDatabase

            class ContentMetadata {
                prop ChapterInfo ChapterInfo
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata };

        var compilation = Compile(sources);
        var errors = AllDiagnostics(compilation).Where(d => d.IsError).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0496");
        Assert.DoesNotContain(errors, d => d.Id == "GS0490");
    }

    // ---- Class / struct literal own-type-name resolution ----

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ClassLiteral_OwnCollidingTypeName_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        // The composite literal's OWN bare type name (`ChapterInfo{...}`, not
        // a target member's declared type) goes through a SEPARATE call site
        // (BindStructLiteralExpression's `scope.TryLookupTypeAlias(typeName,
        // ...)`), independently wired to the same import-based disambiguation.
        const string probe = """
            package Oahu.Core
            import Oahu.Audible.Json

            class Probe {
                func Make() string {
                    var ci = ChapterInfo{}
                    return ci.Chapters.Count.ToString()
                }
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, probe }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, probe };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    [Fact]
    public void ClassLiteral_OwnCollidingTypeName_BothImported_ReportsAmbiguousSourceType()
    {
        const string probe = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.BooksDatabase

            class Probe {
                func Make() int32 {
                    var ci = ChapterInfo{}
                    return 0
                }
            }
            """;

        var compilation = Compile(new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, probe });
        var errors = AllDiagnostics(compilation).Where(d => d.IsError).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0496");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void StructLiteral_ValueType_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        const string audibleStruct = """
            package Oahu.Audible.Json

            struct ChapterInfo {
                prop ChaptersA string
            }
            """;

        const string booksDbStruct = """
            package Oahu.BooksDatabase

            struct ChapterInfo {
                prop ChaptersB string
            }
            """;

        const string probe = """
            package Oahu.Core
            import Oahu.Audible.Json

            class Probe {
                func Make() string {
                    var ci = ChapterInfo{ChaptersA: "hi"}
                    return ci.ChaptersA
                }
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { audibleStruct, booksDbStruct, probe }
            : new[] { booksDbStruct, audibleStruct, probe };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    // ---- Initializer-suffix construction: T(){ Field: value } ----

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void InitializerSuffixConstruction_CollidingTargetFieldType_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        // ADR-0117 / issue #569 object-initializer suffix: `T(){ Field: value
        // }` constructs via T's constructor, then assigns named members —
        // exercised here on a class whose OWN field is declared with the
        // colliding bare simple name, constructed through the parenthesized
        // constructor-call initializer-suffix form rather than the bare `{}`
        // composite literal.
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json

            class ContentMetadata {
                prop ChapterInfo ChapterInfo
            }
            """;

        const string aaxExporter = """
            package Oahu.Core
            import Oahu.Audible.Json

            class AaxExporter {
                func Export(ci ChapterInfo) ContentMetadata {
                    return ContentMetadata(){ChapterInfo = ci}
                }
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata, aaxExporter }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata, aaxExporter };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    // ---- Nested / generic / array / slice member types ----

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ArrayElementType_CollidingSimpleName_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        // The collision must also resolve correctly when the colliding name
        // appears as an ARRAY element type (`[]ChapterInfo`), not just a bare
        // field type — the array/slice type-clause parser recurses into the
        // same bare-name resolution path for its element type.
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json

            class ContentMetadata {
                prop AllChapterInfos []ChapterInfo
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void GenericElementType_CollidingSimpleName_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        // Same as above, but the colliding name appears as a GENERIC type
        // argument (`ICollection[ChapterInfo]`) rather than an array element.
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json
            import System.Collections.Generic

            class ContentMetadata {
                prop AllChapterInfos ICollection[ChapterInfo]
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void NestedContainerFieldType_CollidingSimpleName_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        // The colliding bare name as the type of a field on a NESTED
        // (containing-type-scoped) class, to confirm the fix applies equally
        // regardless of how deeply the declaring type itself is nested.
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json

            class Outer {
                class Inner {
                    prop ChapterInfo ChapterInfo
                }
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    // ---- Fields / properties / constructor parameters ----

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void PlainFieldDeclaredType_CollidingSimpleName_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json

            class ContentMetadata {
                var ChapterInfo ChapterInfo
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void PropertyDeclaredType_CollidingSimpleName_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json

            class ContentMetadata {
                prop ChapterInfo ChapterInfo
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ConstructorParameterDeclaredType_CollidingSimpleName_ImportDisambiguates_OrderIndependent(bool audibleTreeFirst)
    {
        // Primary-constructor parameter type clause — a distinct binder path
        // (constructor parameter list) from a field/property type clause,
        // but both ultimately funnel through the same `BindNonNullableTypeClause`
        // bare-name resolution this fix wires.
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json

            class ContentMetadata(ChapterInfo ChapterInfo) {
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, contentMetadata };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    // ---- Same-package precedence regression guard (issue #2342) ----

    [Fact]
    public void SamePackagePrecedence_OwnCollidingType_StillWinsInsideOwningPackage_Unaffected()
    {
        // Issue #2342 self-preference: even with NO disambiguating import at
        // all, a package whose OWN top-level type lost the plain-simple-key
        // "race" must still resolve ITS OWN same-simple-name type from within
        // its own code. This is orthogonal to (and must remain unaffected by)
        // the #2455 import-based fix, which only kicks in for a REFERENCING
        // package that is neither colliding package itself.
        const string ownerPackageOwnType = """
            package Oahu.BooksDatabase
            import System.Collections.Generic

            class ChapterInfo {
                prop Chapters ICollection[string]
            }

            class Repository {
                func Load() ChapterInfo {
                    return ChapterInfo{}
                }
            }
            """;

        var compilation = Compile(new[] { AudibleChapterInfo, ownerPackageOwnType });

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    // ---- Source type vs. imported CLR type precedence (unaffected control) ----

    [Fact]
    public void SourceTypeVsImportedClrType_SameSimpleName_SourceTypeStillWins()
    {
        // A source-declared type and an imported CLR type that happen to
        // share a simple name are resolved by an entirely different
        // mechanism (TryLookupTypeAlias vs. TryLookupImportedClass) than the
        // #2455 cross-source-package collision this fix targets. Pin that the
        // pre-existing "source type wins" precedence is unaffected.
        const string source = """
            package Oahu.Core
            import System.Text

            class StringBuilder {
                prop Text string
            }

            class Probe {
                func Make() string {
                    var sb = StringBuilder{Text: "hi"}
                    return sb.Text
                }
            }
            """;

        var compilation = Compile(new[] { source });

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    // ---- Compatible / incompatible structural projection (positive controls) ----

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void CompatibleStructuralProjection_AfterIdentityResolved_StillSucceeds_OrderIndependent(bool audibleTreeFirst)
    {
        // Positive control: once ChapterInfo's identity is correctly resolved
        // to Oahu.Audible.Json.ChapterInfo (via the disambiguating import), a
        // DIFFERENT but structurally-compatible source type must still
        // project onto it via ordinary structural typing — the fix must not
        // disable valid structural projection, only fix WHICH type identity
        // the projection is checked against.
        const string sourceShape = """
            package Oahu.Audible.Alt
            import Oahu.Audible.Json

            class ChapterInfoLike {
                prop Chapters []Chapter
            }
            """;

        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.Audible.Alt

            class ContentMetadata {
                prop ChapterInfo ChapterInfo
            }

            class Probe {
                func Make(src ChapterInfoLike) ContentMetadata {
                    return ContentMetadata{ChapterInfo: src}
                }
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, sourceShape, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, sourceShape, contentMetadata };

        var compilation = Compile(sources);

        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void IncompatibleStructuralProjection_AfterIdentityResolved_StillReportsGS0490_OrderIndependent(bool audibleTreeFirst)
    {
        // Positive control for GS0490 itself: once ChapterInfo's identity is
        // correctly (and deterministically) resolved to
        // Oahu.Audible.Json.ChapterInfo, projecting a GENUINELY incompatible
        // shape onto it must still correctly fail with GS0490 — the fix must
        // not suppress or special-case real structural-projection failures,
        // only correct which type identity they are evaluated against.
        const string incompatibleShape = """
            package Oahu.Unrelated

            class TotallyDifferent {
                prop SomeNumber int32
            }
            """;

        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.Unrelated

            class ContentMetadata {
                prop ChapterInfo ChapterInfo
            }

            class Probe {
                func Make(src TotallyDifferent) ContentMetadata {
                    return ContentMetadata{ChapterInfo: src}
                }
            }
            """;

        var sources = audibleTreeFirst
            ? new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, incompatibleShape, contentMetadata }
            : new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, incompatibleShape, contentMetadata };

        var compilation = Compile(sources);
        var errors = AllDiagnostics(compilation).Where(d => d.IsError).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0490");
    }

    // ---- Negative ambiguity controls across multiple binder contexts ----

    [Fact]
    public void FieldDeclaredType_BothImported_ReportsAmbiguousSourceType()
    {
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.BooksDatabase

            class ContentMetadata {
                var ChapterInfo ChapterInfo
            }
            """;

        var compilation = Compile(new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata });
        var errors = AllDiagnostics(compilation).Where(d => d.IsError).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0496");
    }

    [Fact]
    public void ConstructorParameterDeclaredType_BothImported_ReportsAmbiguousSourceType()
    {
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.BooksDatabase

            class ContentMetadata(ChapterInfo ChapterInfo) {
            }
            """;

        var compilation = Compile(new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata });
        var errors = AllDiagnostics(compilation).Where(d => d.IsError).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0496");
    }

    [Fact]
    public void ArrayElementType_BothImported_ReportsAmbiguousSourceType()
    {
        const string contentMetadata = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.BooksDatabase

            class ContentMetadata {
                prop AllChapterInfos []ChapterInfo
            }
            """;

        var compilation = Compile(new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, contentMetadata });
        var errors = AllDiagnostics(compilation).Where(d => d.IsError).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0496");
    }

    // ---- Per-file import scoping (issue #2395 follow-up hardening) ----
    //
    // TryResolveCollidingTypeAliasByImport must NEVER let an import declared
    // in one file decide type identity for a reference in a DIFFERENT file
    // that imports neither colliding package itself. Imports are still bound
    // onto one shared compilation-wide scope (issue #2395's own leak, not
    // fixed by this change), but the collision-disambiguation logic added for
    // #2455 must consult only the REFERENCING file's own imports (plus
    // implicit/compiler-synthesized ones), never a sibling file's.

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void UnrelatedFileImportingOneCollidingPackage_DoesNotLeakIntoResolution_FileWithNoOwnImportKeepsLegacyOrderDependentFallback(bool audibleDeclaredFirst)
    {
        // Dedicated local collision shape (distinct from the shared
        // AudibleChapterInfo/BooksDatabaseChapterInfo constants) with
        // deliberately ASYMMETRIC member names, so a clean member-access
        // check unambiguously reveals which package's ChapterInfo won —
        // `FromAudible` exists ONLY on Oahu.Audible.Json.ChapterInfo.
        const string audibleShape = """
            package Oahu.Audible.Json

            class ChapterInfo {
                prop FromAudible string
            }
            """;

        const string booksDbShape = """
            package Oahu.BooksDatabase

            class ChapterInfo {
                prop FromBooksDb string
            }
            """;

        // `unrelatedImporter` imports ONLY Oahu.BooksDatabase, but never
        // references ChapterInfo (or anything from `probe`) at all — it is
        // completely unrelated to `probe`'s own file. `probe` itself imports
        // NEITHER colliding package.
        //
        // Before the per-file scoping fix, TryResolveCollidingTypeAliasByImport
        // consulted the compilation-wide import set (EnumerateImports() walks
        // every file's imports with no per-file boundary — issue #2395), so
        // finding exactly one colliding package (Oahu.BooksDatabase) imported
        // ANYWHERE would deterministically resolve `probe`'s bare
        // `ChapterInfo` reference to Oahu.BooksDatabase.ChapterInfo — in
        // BOTH declaration orders, regardless of `probe` importing nothing.
        // That is exactly the leak the user identified: an import in one
        // file silently deciding identity in a wholly unrelated file.
        //
        // After the fix, `unrelatedImporter`'s import must never be consulted
        // for `probe`'s reference (it is declared in a different syntax
        // tree), so `probe` falls back to the ORIGINAL, pre-#2455
        // order-dependent "first declared wins" behavior — exactly like
        // AbsentDisambiguatingImport_PreservesLegacyOrderDependentFallback_DocumentedNotFixed
        // above, flipping with declaration order rather than being pinned to
        // Oahu.BooksDatabase regardless of order.
        const string unrelatedImporter = """
            package Oahu.Other
            import Oahu.BooksDatabase

            class Unrelated {
                func Noop() int {
                    return 0
                }
            }
            """;

        const string probe = """
            package Oahu.Core

            class Probe {
                func Make() string {
                    var ci = ChapterInfo{}
                    return ci.FromAudible
                }
            }
            """;

        var sources = audibleDeclaredFirst
            ? new[] { audibleShape, booksDbShape, unrelatedImporter, probe }
            : new[] { booksDbShape, audibleShape, unrelatedImporter, probe };

        var compilation = Compile(sources);
        var errors = AllDiagnostics(compilation).Where(d => d.IsError).ToArray();

        // Never the fix's own ambiguity diagnostic (there is genuinely no
        // same-file disambiguating import here) — and, critically, whether
        // `ci.FromAudible` resolves cleanly must track declaration ORDER, not
        // be pinned to Oahu.BooksDatabase.ChapterInfo (which has no
        // `FromAudible` member) regardless of order.
        Assert.DoesNotContain(errors, d => d.Id == "GS0496");
        if (audibleDeclaredFirst)
        {
            // Oahu.Audible.Json.ChapterInfo (which HAS FromAudible) won the
            // legacy plain-key race — `ci.FromAudible` must resolve cleanly.
            Assert.Empty(errors);
        }
        else
        {
            // Oahu.BooksDatabase.ChapterInfo (which has no FromAudible) won
            // the legacy plain-key race — `ci.FromAudible` must fail to find
            // a member, proving `unrelatedImporter`'s import of
            // Oahu.BooksDatabase was NOT consulted (a leaked, compilation-
            // wide disambiguation would have forced Oahu.BooksDatabase.
            // ChapterInfo to win in BOTH orders, never reaching this
            // branch's failure).
            Assert.Contains(errors, d => d.Id == "GS0158");
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void SameFileImport_DisambiguatesOrderIndependently_EvenWhenAnUnrelatedFileImportsTheOtherCollidingPackage(bool audibleDeclaredFirst)
    {
        const string audibleShape = """
            package Oahu.Audible.Json

            class ChapterInfo {
                prop FromAudible string
            }
            """;

        const string booksDbShape = """
            package Oahu.BooksDatabase

            class ChapterInfo {
                prop FromBooksDb string
            }
            """;

        // The exact real-world (AaxExporter) shape: `probe`'s OWN file
        // imports Oahu.Audible.Json, so its bare `ChapterInfo` reference must
        // always resolve to Oahu.Audible.Json.ChapterInfo, regardless of
        // declaration order AND regardless of `unrelatedImporter` (a
        // completely different, unrelated file) importing the OTHER
        // colliding package (Oahu.BooksDatabase). A same-file import must
        // always win for that file's own references — a sibling file's
        // import of the OTHER colliding package must never turn this into a
        // false GS0496 ambiguity, and must never flip the result toward
        // Oahu.BooksDatabase.ChapterInfo.
        const string unrelatedImporter = """
            package Oahu.Other
            import Oahu.BooksDatabase

            class Unrelated {
                func Noop() int {
                    return 0
                }
            }
            """;

        const string probe = """
            package Oahu.Core
            import Oahu.Audible.Json

            class Probe {
                func Make() string {
                    var ci = ChapterInfo{}
                    return ci.FromAudible
                }
            }
            """;

        var sources = audibleDeclaredFirst
            ? new[] { audibleShape, booksDbShape, unrelatedImporter, probe }
            : new[] { booksDbShape, audibleShape, unrelatedImporter, probe };

        var compilation = Compile(sources);

        // Always clean: same-file import deterministically wins, in both
        // declaration orders, unaffected by the unrelated file's opposing
        // import.
        Assert.DoesNotContain(AllDiagnostics(compilation), d => d.IsError);
    }

    // ---- Documented residual (not fixed here; reported as next blocker) ----

    [Fact]
    public void AbsentDisambiguatingImport_PreservesLegacyOrderDependentFallback_DocumentedNotFixed()
    {
        // When NEITHER colliding package is imported anywhere in the
        // compilation, there is no import-based signal to disambiguate with,
        // so the pre-existing "first declared wins" plain-key fallback runs
        // completely unchanged (this test pins that legacy behavior remains
        // exactly as before, rather than being silently altered by this fix).
        // This residual order-dependence — a bare reference to a colliding
        // simple name with NO disambiguating import at all — is a distinct,
        // deliberately out-of-scope follow-up (see the PR description for
        // #2455): fully eliminating it would require treating EVERY
        // unqualified cross-package collision as an error unless qualified,
        // a broader behavior change with its own regression surface.
        const string probe = """
            package Oahu.Core

            class Probe {
                func Make() string {
                    var ci = ChapterInfo{}
                    return ci.ToString()
                }
            }
            """;

        var firstOrder = Compile(new[] { AudibleChapterInfo, BooksDatabaseChapterInfo, probe });
        var secondOrder = Compile(new[] { BooksDatabaseChapterInfo, AudibleChapterInfo, probe });

        // Both orders bind (no ambiguity diagnostic — this shape doesn't
        // reference any member, so either winning type satisfies it), but the
        // point being pinned is that this scenario is untouched by the fix:
        // no GS0496 is ever raised when neither package is imported.
        Assert.DoesNotContain(AllDiagnostics(firstOrder), d => d.Id == "GS0496");
        Assert.DoesNotContain(AllDiagnostics(secondOrder), d => d.Id == "GS0496");
    }

    private static Compilation Compile(string[] sources)
    {
        var trees = sources.Select(s => GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(s))).ToArray();
        return new Compilation(trees) { IsLibrary = true };
    }

    /// <summary>
    /// Field/property/constructor-parameter declared-type resolution (and
    /// other declaration-binding-phase checks) report their diagnostics onto
    /// <see cref="Compilation.GlobalScope"/>, not <see cref="Compilation.BoundProgram"/>
    /// (which only carries diagnostics from function/method BODY and
    /// top-level-statement binding — see <see cref="Compilation.Evaluate(System.Collections.Generic.Dictionary{GSharp.Core.CodeAnalysis.Symbols.VariableSymbol, object})"/>,
    /// which concatenates both sets for exactly this reason). Tests here must
    /// look at both sets, mirroring <c>Evaluate</c>, or a genuine
    /// declaration-phase diagnostic (e.g. this issue's GS0496, or a plain
    /// GS0157) is silently missed.
    /// </summary>
    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> AllDiagnostics(Compilation compilation)
        => compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics);
}
