// <copyright file="Issue2455QualifiedConstructorCallVsClrImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2455 (real-world Oahu shape, second root cause): the actual
/// <c>AaxExporter.cs</c> in Oahu does not construct its Audible
/// <c>ChapterInfo</c> via a struct/class LITERAL (already covered by
/// <see cref="Issue2455CompositeTypeCollisionTests"/> and
/// <c>Issue2455CompositeTypeCollisionEmitTests</c>) — it constructs it via a
/// package-qualified, zero-argument bare constructor CALL:
/// <c>new Oahu.Audible.Json.ChapterInfo()</c>, translated by cs2gs to
/// <c>Oahu.Audible.Json.ChapterInfo()</c>. This is peeled by
/// <c>ExpressionBinder.Access.TryBindQualifiedSourceTypeConstruction</c> down
/// to the bare terminal call <c>ChapterInfo()</c>, bound by
/// <c>OverloadResolver.CallBinding.BindCallExpression</c> — an entirely
/// different code path from <c>ExpressionBinder.Literals.BindStructLiteralExpression</c>
/// (used for <c>Type{...}</c>), which already correctly checked
/// <c>BoundScope.TryLookupTypeAlias</c> (source types) before ever falling
/// back to <c>TryLookupImportedClass</c> (CLR-imported types).
/// <para>
/// Before this fix, <c>BindCallExpression</c> attempted
/// <c>tryBindClrConstructorCall</c> (which resolves a same-simple-name
/// CLR-IMPORTED class via <c>TryLookupImportedClass</c>) UNCONDITIONALLY
/// whenever no same-name user function/method existed
/// (<c>HasUserCallableCandidate</c>, issue #2403) — never checking whether a
/// genuine SOURCE type alias existed for the name first. So whenever the
/// consuming package also imported a sibling package/assembly that happened
/// to define an unrelated CLR class of the exact same simple name (e.g.
/// <c>import Oahu.BooksDatabase</c>, which resolves to CLR metadata compiled
/// from <c>Oahu.Data.dll</c>, defining its own incompatible
/// <c>Oahu.BooksDatabase.ChapterInfo</c>), a bare/qualified constructor call
/// ALWAYS constructed the CLR-imported type instead of the intended source
/// type — regardless of package qualification, import order, or the
/// qualified-construction-package-hint (which is only consulted inside
/// <c>TryLookupTypeAlias</c>, a path this bare-call binder never reached).
/// This silently produced the WRONG runtime type, later misfiring
/// <c>GS0490</c> (<c>StructuralProjectionFailure</c>) at the composite
/// literal that assigns it to a member declared as the SOURCE type.
/// </para>
/// These tests use a REAL C#-compiled (not gsc-compiled) CLR reference
/// assembly for the colliding <c>Oahu.BooksDatabase.ChapterInfo</c>, mirroring
/// the actual Oahu corpus shape exactly (<c>Oahu.Data.dll</c> is CLR
/// metadata, never translated to G# source) — unlike the existing
/// struct-literal-focused emit tests, which (correctly, for THAT scenario)
/// use two G# source packages in the same compilation.
/// </summary>
public class Issue2455QualifiedConstructorCallVsClrImportTests
{
    private const string AudibleChapterInfoGs = """
        package Oahu.Audible.Json

        class ChapterInfo {
            prop Chapters []Chapter
        }

        class Chapter {
            prop Title string
        }
        """;

    [Fact]
    public void QualifiedBareConstructorCall_CollidesWithImportedClrClass_ResolvesSourceType_NotClrType()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.QualifiedBareConstructorCall_CollidesWithImportedClrClass_ResolvesSourceType_NotClrType),
            """
            using System.Collections.Generic;
            namespace Oahu.BooksDatabase
            {
                public class ChapterInfo { public ICollection<Chapter> Chapters { get; set; } }
                public class Chapter { public string Name { get; set; } }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(AudibleChapterInfoGs)),
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Oahu.Core
                import Oahu.Audible.Json
                import Oahu.BooksDatabase

                class ContentMetadata {
                    prop ChapterInfo ChapterInfo
                }

                func Run() ContentMetadata {
                    let ci = Oahu.Audible.Json.ChapterInfo()
                    return ContentMetadata{ChapterInfo: ci}
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0490");
    }

    [Fact]
    public void UnqualifiedBareConstructorCall_CollidesWithImportedClrClass_ImportDisambiguates()
    {
        // Same collision, but the reference to the Audible sibling's
        // ChapterInfo is UNQUALIFIED (`ChapterInfo()`, no package prefix at
        // all — not even peeled via TryBindQualifiedSourceTypeConstruction).
        // Only Oahu.Audible.Json (the source package) is imported here —
        // Oahu.BooksDatabase (the CLR-imported package) is NOT imported in
        // this consuming package, so there is exactly one plausible
        // candidate.
        var libraryPath = EmitCSharpLibrary(
            nameof(this.UnqualifiedBareConstructorCall_CollidesWithImportedClrClass_ImportDisambiguates),
            """
            using System.Collections.Generic;
            namespace Oahu.BooksDatabase
            {
                public class ChapterInfo { public ICollection<Chapter> Chapters { get; set; } }
                public class Chapter { public string Name { get; set; } }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(AudibleChapterInfoGs)),
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Oahu.Core
                import Oahu.Audible.Json

                class ContentMetadata {
                    prop ChapterInfo ChapterInfo
                }

                func Run() ContentMetadata {
                    let ci = ChapterInfo()
                    return ContentMetadata{ChapterInfo: ci}
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0490");
    }

    [Fact]
    public void BareConstructorCall_NoSourceCollision_StillConstructsClrType()
    {
        // Negative/regression control: when NO colliding source type alias
        // exists at all, a bare constructor call for a same-simple-name CLR
        // import must still construct the CLR type exactly as before this
        // fix — this fix must not disturb ordinary CLR-class construction
        // (e.g. `StringBuilder(16)`) when there is nothing to disambiguate.
        var libraryPath = EmitCSharpLibrary(
            nameof(this.BareConstructorCall_NoSourceCollision_StillConstructsClrType),
            """
            namespace Oahu.BooksDatabase
            {
                public class OnlyClrType { public int Value { get; set; } = 42; }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Oahu.Core
                import Oahu.BooksDatabase

                func Run() int32 {
                    let x = OnlyClrType()
                    return x.Value
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string EmitCSharpLibrary(string caseName, string csharpSource)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2455ClrCollision", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "CSharpLib2455.dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(
            csharpSource,
            new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "CSharpLib2455",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }
}
