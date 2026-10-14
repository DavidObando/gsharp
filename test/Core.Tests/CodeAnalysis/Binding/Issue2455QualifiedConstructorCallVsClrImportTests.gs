// <copyright file="Issue2455QualifiedConstructorCallVsClrImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #2455 (real-world Oahu shape, second root cause): the actual
/// `AaxExporter.cs` in Oahu does not construct its Audible
/// `ChapterInfo` via a struct/class LITERAL (already covered by
/// (cref:Issue2455CompositeTypeCollisionTests) and
/// `Issue2455CompositeTypeCollisionEmitTests`) — it constructs it via a
/// package-qualified, zero-argument bare constructor CALL:
/// `new Oahu.Audible.Json.ChapterInfo()`, translated by cs2gs to
/// `Oahu.Audible.Json.ChapterInfo()`. This is peeled by
/// `ExpressionBinder.Access.TryBindQualifiedSourceTypeConstruction` down
/// to the bare terminal call `ChapterInfo()`, bound by
/// `OverloadResolver.CallBinding.BindCallExpression` — an entirely
/// different code path from `ExpressionBinder.Literals.BindStructLiteralExpression`
/// (used for `Type{...}`), which already correctly checked
/// `BoundScope.TryLookupTypeAlias` (source types) before ever falling
/// back to `TryLookupImportedClass` (CLR-imported types).
///
/// Before this fix, `BindCallExpression` attempted
/// `tryBindClrConstructorCall` (which resolves a same-simple-name
/// CLR-IMPORTED class via `TryLookupImportedClass`) UNCONDITIONALLY
/// whenever no same-name user function/method existed
/// (`HasUserCallableCandidate`, issue #2403) — never checking whether a
/// genuine SOURCE type alias existed for the name first. So whenever the
/// consuming package also imported a sibling package/assembly that happened
/// to define an unrelated CLR class of the exact same simple name (e.g.
/// `import Oahu.BooksDatabase`, which resolves to CLR metadata compiled
/// from `Oahu.Data.dll`, defining its own incompatible
/// `Oahu.BooksDatabase.ChapterInfo`), a bare/qualified constructor call
/// ALWAYS constructed the CLR-imported type instead of the intended source
/// type — regardless of package qualification, import order, or the
/// qualified-construction-package-hint (which is only consulted inside
/// `TryLookupTypeAlias`, a path this bare-call binder never reached).
/// This silently produced the WRONG runtime type, later misfiring
/// `GS0490` (`StructuralProjectionFailure`) at the composite
/// literal that assigns it to a member declared as the SOURCE type.
///
/// These tests use a REAL C#-compiled (not gsc-compiled) CLR reference
/// assembly for the colliding `Oahu.BooksDatabase.ChapterInfo`, mirroring
/// the actual Oahu corpus shape exactly (`Oahu.Data.dll` is CLR
/// metadata, never translated to G# source) — unlike the existing
/// struct-literal-focused emit tests, which (correctly, for THAT scenario)
/// use two G# source packages in the same compilation.
open class Issue2455QualifiedConstructorCallVsClrImportTests {
    @Fact
    func QualifiedBareConstructorCall_CollidesWithImportedClrClass_ResolvesSourceType_NotClrType() {
        let libraryPath = EmitCSharpLibrary(
            "QualifiedBareConstructorCall_CollidesWithImportedClrClass_ResolvesSourceType_NotClrType",
            `using System.Collections.Generic;
namespace Oahu.BooksDatabase
{
    public class ChapterInfo { public ICollection<Chapter> Chapters { get; set; } }
    public class Chapter { public string Name { get; set; } }
}`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(AudibleChapterInfoGs)),
            GsSyntaxTree.Parse(SourceText.From(`package Oahu.Core
import Oahu.Audible.Json
import Oahu.BooksDatabase

class ContentMetadata {
    prop ChapterInfo ChapterInfo
}

func Run() ContentMetadata {
    let ci = Oahu.Audible.Json.ChapterInfo()
    return ContentMetadata{ChapterInfo: ci}
}`))
        )
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0490")
    }

    @Fact
    func UnqualifiedBareConstructorCall_CollidesWithImportedClrClass_ImportDisambiguates() {
        // Same collision, but the reference to the Audible sibling's
        // ChapterInfo is UNQUALIFIED (`ChapterInfo()`, no package prefix at
        // all — not even peeled via TryBindQualifiedSourceTypeConstruction).
        // Only Oahu.Audible.Json (the source package) is imported here —
        // Oahu.BooksDatabase (the CLR-imported package) is NOT imported in
        // this consuming package, so there is exactly one plausible
        // candidate.
        let libraryPath = EmitCSharpLibrary(
            "UnqualifiedBareConstructorCall_CollidesWithImportedClrClass_ImportDisambiguates",
            `using System.Collections.Generic;
namespace Oahu.BooksDatabase
{
    public class ChapterInfo { public ICollection<Chapter> Chapters { get; set; } }
    public class Chapter { public string Name { get; set; } }
}`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(AudibleChapterInfoGs)),
            GsSyntaxTree.Parse(SourceText.From(`package Oahu.Core
import Oahu.Audible.Json

class ContentMetadata {
    prop ChapterInfo ChapterInfo
}

func Run() ContentMetadata {
    let ci = ChapterInfo()
    return ContentMetadata{ChapterInfo: ci}
}`))
        )
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0490")
    }

    @Fact
    func BareConstructorCall_NoSourceCollision_StillConstructsClrType() {
        // Negative/regression control: when NO colliding source type alias
        // exists at all, a bare constructor call for a same-simple-name CLR
        // import must still construct the CLR type exactly as before this
        // fix — this fix must not disturb ordinary CLR-class construction
        // (e.g. `StringBuilder(16)`) when there is nothing to disambiguate.
        let libraryPath = EmitCSharpLibrary("BareConstructorCall_NoSourceCollision_StillConstructsClrType", `namespace Oahu.BooksDatabase
{
    public class OnlyClrType { public int Value { get; set; } = 42; }
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Oahu.Core
import Oahu.BooksDatabase

func Run() int32 {
    let x = OnlyClrType()
    return x.Value
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    shared {
        private const AudibleChapterInfoGs string = `package Oahu.Audible.Json

class ChapterInfo {
    prop Chapters []Chapter
}

class Chapter {
    prop Title string
}`

        private func EmitCSharpLibrary(caseName string, csharpSource string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2455ClrCollision", caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "CSharpLib2455.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "CSharpLib2455",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }
    }
}
