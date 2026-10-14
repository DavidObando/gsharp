// <copyright file="Issue2222TopLevelTypeQualificationTranslationTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2222: two TOP-LEVEL types sharing a simple name in different
/// namespaces, both imported into the same file, must be emitted qualified
/// (`Namespace.Type`) so gsc's flat import scope binds each reference to
/// the right type instead of silently picking whichever homonym resolves
/// first (the reported GS0155/GS0158 cascade). Generalizes the #1174
/// nested-type homonym check — which only covered SOURCE-declared nested
/// types — to `QualifiedTypeName`'s top-level branch, and additionally
/// covers a homonym declared in a REFERENCED ASSEMBLY (a translated sibling
/// project surfaced as a metadata reference), not just one declared in this
/// compilation's own source.
open class Issue2222TopLevelTypeQualificationTranslationTests {
    /// Two source-declared top-level types sharing the simple name
    /// `ChapterInfo`, both imported into one file: the materialized `var`
    /// local's inferred type AND an explicitly-qualified constructor call must
    /// both round-trip fully qualified.
    @Fact
    func SourceHomonym_AcrossImportedNamespaces_IsEmittedQualified() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("First.cs", `
namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}
`), ("Second.cs", `
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
`), ("Caller.cs", `
using First;
using Second;

namespace Consumer
{
    public class Book
    {
        public First.ChapterInfo ChapterInfo;
    }

    public class Caller
    {
        public void Use(Book book)
        {
            var chapterInfo = book.ChapterInfo;
            var ci = new Second.ChapterInfo();
            System.Console.WriteLine(chapterInfo.RuntimeLengthSec);
            System.Console.WriteLine(ci.Asin);
        }
    }
}
`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let printed = TranslateTargetAndAssertProjectBinds(project, "Caller.cs")
        // The `var` local's materialized type annotation is qualified...
        Assert.Contains("First.ChapterInfo", printed)
        // ...and the explicit constructor call keeps its qualification instead
        // of collapsing to the bare (ambiguous) `ChapterInfo()`.
        Assert.Contains("Second.ChapterInfo()", printed)
    }

    @Fact
    func NestedSameArityType_DoesNotQualifyImportedTopLevelSourceType() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Library.cs", `namespace Library
{
    public sealed class FakeLibraryService
    {
        public FakeLibraryService(int count) { }
    }
}`), ("Caller.cs", `using Library;

namespace Tests
{
    public sealed class Container
    {
        public sealed class FakeLibraryService
        {
        }
    }

    public static class Caller
    {
        public static object Make() => new FakeLibraryService(1);
    }
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let printed = TranslateTargetAndAssertProjectBinds(project, "Caller.cs")
        Assert.Contains("FakeLibraryService(1)", printed)
        Assert.DoesNotContain("import LibraryFakeLibraryService =", printed)
        Assert.DoesNotContain("Library.FakeLibraryService(1)", printed)
    }

    /// Same simple-name collision, but the second `ChapterInfo` lives in a
    /// REFERENCED ASSEMBLY (compiled to metadata, simulating a translated
    /// sibling project) rather than in this compilation's own source. The
    /// #1174 census only ever counted source-declared types, so this is the
    /// case that needs the cross-assembly homonym check.
    @Fact
    func MetadataHomonym_AcrossImportedNamespaces_IsEmittedQualified() {
        let libRef = CompileLibrary(`
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
`, "Issue2222SecondLib")
        const Source = `
using First;
using Second;

namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}

namespace Consumer
{
    public class Caller
    {
        public First.ChapterInfo Make()
        {
            return new First.ChapterInfo();
        }
    }
}
`
        let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
        let tree = CSharpSyntaxTree.ParseText(Source, parseOptions, path: "Caller.cs")
        let compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2222.MetadataHomonymInMemory",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument("Caller.cs", tree, model)
        let context = TranslationContext(compilation, model, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        // `First.ChapterInfo` is ambiguous with the metadata `Second.ChapterInfo`
        // reachable through the file's own `using Second;` — both the return
        // type (`func Make(): First.ChapterInfo`) and the constructor call
        // (`new First.ChapterInfo()`) must be qualified. A single occurrence
        // wouldn't prove that; assert both usages so this doesn't quietly
        // regress to only qualifying one of them.
        Assert.Equal(2, CountOccurrences(printed, "First.ChapterInfo"))
        Assert.DoesNotContain(" ChapterInfo(", printed)
        let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Target-only fixture omits the referenced metadata assembly from emitted G#."
        )
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
    }

    @Fact
    func MetadataType_WithSourceHomonym_IsEmittedQualified() {
        let libRef = CompileLibrary(`
namespace Oahu.BooksDatabase
{
    public class Codec
    {
        public string Name { get; set; }
    }
}
`, "Issue2307OahuData")
        let sourceHomonym = CSharpSyntaxTree.ParseText(`
namespace Oahu.Audible.Json
{
    public class Codec
    {
        public int Id { get; set; }
    }
}
`, CSharpParseOptions(LanguageVersion.Latest), path: "AudibleCodec.cs")
        let caller = CSharpSyntaxTree.ParseText(`
using System.Collections.Generic;
using System.Linq;
using Oahu.Audible.Json;
using Oahu.BooksDatabase;

namespace Oahu.Core
{
    public class C
    {
        public Oahu.BooksDatabase.Codec Find(
            ICollection<Oahu.BooksDatabase.Codec> codecs,
            string name)
        {
            return codecs.FirstOrDefault(
                (Oahu.BooksDatabase.Codec c) => c.Name == name);
        }
    }
}
`, CSharpParseOptions(LanguageVersion.Latest), path: "Caller.cs")
        let compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2307.MetadataTypeWithSourceHomonym",
            []SyntaxTree{sourceHomonym, caller},
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let model = compilation.GetSemanticModel(caller)
        let document = LoadedDocument("Caller.cs", caller, model)
        let context = TranslationContext(compilation, model, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("ICollection[Oahu.BooksDatabase.Codec]", printed)
        Assert.Contains("(c Oahu.BooksDatabase.Codec)", printed)
        let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Target-only fixture omits the referenced metadata assembly from emitted G#."
        )
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
    }

    @Fact
    func MetadataHomonym_WithSameNamespaceSourceDeclaration_UsesSimpleName() {
        let libRef = CompileLibrary(`namespace Microsoft.AspNetCore.OpenApi.Generated
{
    public class XmlParameterComment
    {
    }
}`, "Issue3395GeneratedTypes")
        let tree = CSharpSyntaxTree.ParseText(`using System.Collections.Generic;

namespace System.Runtime.CompilerServices
{
    internal sealed class InterceptsLocationAttribute
    {
    }
}

namespace Microsoft.AspNetCore.OpenApi.Generated
{
    internal sealed class XmlParameterComment
    {
    }

    internal sealed class XmlComment
    {
        public List<XmlParameterComment> Parameters { get; set; }
    }
}`, CSharpParseOptions(LanguageVersion.Latest), path: "OpenApiXmlCommentSupport.generated.cs")
        let compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue3395.GeneratedSourceMetadataHomonym",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument(tree.FilePath, tree, model)
        let context = TranslationContext(compilation, model, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("List[XmlParameterComment]", printed)
        Assert.DoesNotContain("List[Microsoft.AspNetCore.OpenApi.Generated.XmlParameterComment]", printed)
        let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Generated source intentionally contains multiple C# namespaces."
        )
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
    }

    /// Issue #2222 ordering blindspot: namespace `First` is reached via
    /// an explicit `using`, but the colliding namespace `Second` is
    /// reached ONLY via full qualification (`new Second.ChapterInfo()`),
    /// with NO `using Second;` anywhere in the file. Because
    /// `Second`'s namespace only enters scope as a synthesized `import`
    /// (added after the whole file is visited), an EARLIER bare reference to
    /// `ChapterInfo` from `First` must still be qualified — it cannot rely on
    /// the `using Second;` that doesn't exist to detect the collision.
    @Fact
    func SourceHomonym_ReachedOnlyViaFullQualification_StillQualifiesEarlierBareReference() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("First.cs", `
namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}
`), ("Second.cs", `
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
`), ("Caller.cs", (`
using First;

namespace Consumer
{
    public class Caller
    {
        public void Use()
        {
            // Bare reference to First.ChapterInfo, processed BEFORE the
            // Second.ChapterInfo reference below. No ` + "`" + `using Second;` + "`" + ` exists
            // anywhere in this file — Second is reached only by full
            // qualification.
            var chapterInfo = new First.ChapterInfo();
            var other = new Second.ChapterInfo();
            System.Console.WriteLine(chapterInfo.RuntimeLengthSec);
            System.Console.WriteLine(other.Asin);
        }
    }
}
`))})
        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let printed = TranslateTargetAndAssertProjectBinds(project, "Caller.cs")
        // The EARLIER reference (First.ChapterInfo) must be qualified even
        // though, at the point it's processed, no explicit `using Second;`
        // exists yet to reveal the collision.
        Assert.Contains("First.ChapterInfo()", printed)
        Assert.Contains("Second.ChapterInfo()", printed)
        Assert.DoesNotContain(" ChapterInfo(", printed)
    }

    /// Issue #2222 low-severity fix: a `using global::Foo.Bar;` directive
    /// must be recognized the same as `using Foo.Bar;` — the `global::`
    /// alias-qualifier prefix must be stripped before the namespace name is
    /// parsed/split, or the homonym scan silently fails to match.
    @Fact
    func SourceHomonym_ViaGlobalQualifiedUsing_IsEmittedQualified() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("First.cs", `
namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}
`), ("Second.cs", `
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
`), ("Caller.cs", `
using global::First;
using global::Second;

namespace Consumer
{
    public class Caller
    {
        public void Use()
        {
            var chapterInfo = new First.ChapterInfo();
            var other = new Second.ChapterInfo();
            System.Console.WriteLine(chapterInfo.RuntimeLengthSec);
            System.Console.WriteLine(other.Asin);
        }
    }
}
`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let printed = TranslateTargetAndAssertProjectBinds(project, "Caller.cs")
        Assert.Contains("First.ChapterInfo()", printed)
        Assert.Contains("Second.ChapterInfo()", printed)
        Assert.DoesNotContain(" ChapterInfo(", printed)
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            for var index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(
                needle,
                index + needle.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

        private func TranslateTargetAndAssertProjectBinds(project LoadedCSharpProject, targetFile string) string {
            let translator = CSharpToGSharpTranslator()
            let translated = project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    let unit = translator.TranslateDocument(document, context)
                    return (document.FilePath, Printed: GSharpPrinter.Print(unit))
                }
            )
                .ToArray()
            for result in translated {
                let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                    result.Item2,
                    "Binder.BindGlobalScope flattens multi-package fixtures and cannot resolve their qualified source types."
                )
                Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
            }
            return translated.Single(
                (result(FilePath string, Printed string)) -> result.Item1.EndsWith(targetFile, StringComparison.Ordinal)
            )
                .Item2
        }

        private func CompileLibrary(libSource string, assemblyName string) MetadataReference {
            let libTree = CSharpSyntaxTree.ParseText(libSource, CSharpParseOptions(LanguageVersion.Latest))
            let libCompilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{libTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let peStream = MemoryStream()
            let emit = libCompilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return MetadataReference.CreateFromStream(peStream)
        }
    }
}
