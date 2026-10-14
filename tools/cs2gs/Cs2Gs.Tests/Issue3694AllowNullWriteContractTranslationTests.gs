// <copyright file="Issue3694AllowNullWriteContractTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #3694: the WRITE direction of the
/// cross-nullable-context problem whose read direction is #3683/#3687.
///
/// A nullable-<em>oblivious</em> consumer (every `test/*` project sets
/// `<Nullable>disable</Nullable>`) writes `null` into a
/// property declared non-nullable by an <em>annotated</em> library
/// (`src/Core`) whose setter deliberately normalises `null`. C#
/// reports nothing — the write crosses a nullable-context boundary — so no
/// forgiveness or promotion predicate fires, and gsc then rejects the
/// `nil` at a non-nullable target (GS0155).
///
/// The repair is the declaration-local one: C# spells "the setter accepts
/// `null`, the getter never returns it" with
/// (cref:System.Diagnostics.CodeAnalysis.AllowNullAttribute), and G#
/// — which, like Kotlin, has a single nullability per declaration rather than
/// separate input and output contracts — can only honour that by rendering the
/// declaration `T?`. So an `[AllowNull]` reference declaration is
/// promoted, in every compilation that sees it, on the strength of the
/// attribute alone. No consumer evidence, and no cross-project taint, is
/// consulted: the answer is a property of the declaration and is therefore the
/// same whichever project is being translated.
open class Issue3694AllowNullWriteContractTranslationTests {
    @Fact
    func AnnotatedAllowNullProperty_RendersNullableDeclaration() {
        // The library itself is nullable-ENABLED, so nothing in #2113's
        // oblivious taint machinery runs for it. `[AllowNull]` alone decides:
        // the write contract admits nil, and G# has only one contract per
        // declaration, so the declaration is `Options?`.
        let (library, _) = TranslateLibraryAndConsumer(`
using Library;

namespace App
{
    public static class Use
    {
        public static Host Make() => new Host();
    }
}`)
        Assert.Contains("Debug Options?", library)
    }

    @Fact
    func ObliviousConsumer_WritesNilIntoAllowNullProperty_NeedsNoBridge() {
        // The #3694 site itself: an oblivious test writes `null` into the
        // annotated property through an object initializer. Once the
        // declaration is `Options?` the `nil` binds directly — there is no
        // `!!` that could bridge "assign nil to a non-nil target" anyway, and
        // forcing one would turn a deliberate, supported C# assignment into a
        // runtime throw.
        let (_, consumer) = TranslateLibraryAndConsumer(`
using Library;

namespace App
{
    public static class Use
    {
        public static Host Make() => new Host { Debug = null };
    }
}`)
        Assert.Contains("Host{Debug: nil}", Compact(consumer))
        Assert.DoesNotContain("nil!!", Compact(consumer))
    }

    @Fact
    func ObliviousConsumer_ReadsAllowNullProperty_ForgivesTheNullableGetter() {
        // Promoting the declaration widens the GETTER too, so every read of it
        // across the corpus has to be forgiven. That cascade is the existing
        // use-site forgiveness pass — the same predicate decides both — and it
        // is sound here because the setter's normalisation means the getter
        // never actually observes nil.
        let (_, consumer) = TranslateLibraryAndConsumer(`
using Library;

namespace App
{
    public static class Use
    {
        public static int Read(Host host) { return host.Debug.Format; }
    }
}`)
        Assert.Contains("host.Debug!!.Format", Compact(consumer))
    }

    @Fact
    func AnnotatedPropertyWithoutAllowNull_StaysNonNullable() {
        // The negative control that keeps this narrow: an ordinary annotated
        // non-nullable property is untouched. Only the attribute that states
        // the null-accepting write contract promotes.
        const library = `
namespace Library
{
    public class Options
    {
        public int Format { get; set; }
    }

    public class Host
    {
        public Options Debug { get; set; } = new Options();
    }
}`
        let projectLibrary = LoadEnabled(library, "Library")
        let printed = TranslateProject(projectLibrary, []CSharpCompilation{projectLibrary.Compilation})
        Assert.Contains("Debug Options", printed)
        Assert.DoesNotContain("Debug Options?", printed)
    }

    @Fact
    func AllowNullParameter_RendersNullableParameter() {
        // The attribute is legal on parameters too, and means exactly the same
        // thing there: the caller may pass null.
        const library = `
using System.Diagnostics.CodeAnalysis;

namespace Library
{
    public class Host
    {
        public string Normalise([AllowNull] string value) => value ?? string.Empty;
    }
}`
        let projectLibrary = LoadEnabled(library, "Library")
        let printed = TranslateProject(projectLibrary, []CSharpCompilation{projectLibrary.Compilation})
        Assert.Contains("Normalise(@AllowNull value string?) string", printed)
    }

    shared {
        private const AnnotatedLibrary string = `
using System.Diagnostics.CodeAnalysis;

namespace Library
{
    public class Options
    {
        public int Format { get; set; }
    }

    public class Host
    {
        private Options options = new Options();

        /// <summary>Setting null is normalised to a fresh default instance.</summary>
        [AllowNull]
        public Options Debug
        {
            get => this.options;
            set => this.options = value ?? new Options();
        }
    }
}`

        // ---- Helpers -------------------------------------------------------------
        // The two-compilation idiom of Issue2113ObliviousNullableTranslationTests /
        // Issue2412CrossProjectObliviousNullabilityTranslationTests: an ANNOTATED
        // library plus an OBLIVIOUS consumer, translated in one run so both see the
        // same repository compilations.
        private func TranslateLibraryAndConsumer(consumerSource string)(Library string, Consumer string) {
            let projectLibrary = LoadEnabled(AnnotatedLibrary, "Library")
            let projectApp = LoadOblivious(
                consumerSource,
                "App",
                []MetadataReference{projectLibrary.Compilation.ToMetadataReference()}
            )
            let repository = []CSharpCompilation{projectLibrary.Compilation, projectApp.Compilation}
            return (TranslateProject(projectLibrary, repository), TranslateProject(projectApp, repository))
        }

        private func LoadOblivious(
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

        // `CSharpProjectLoader.LoadInMemory` always builds an oblivious
        // compilation, so a genuinely ANNOTATED library has to be constructed
        // directly with `WithNullableContextOptions(Enable)`.
        private func LoadEnabled(source string, assemblyName string) LoadedCSharpProject {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let diagnostics = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
            Assert.True(
                diagnostics.Count == 0,
                "$assemblyName should bind with no C# errors: " + string.Join(Environment.NewLine, diagnostics)
            )
            let document = LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree))
            return LoadedCSharpProject(compilation, []LoadedDocument{document}, Array.Empty[Diagnostic]())
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            repositoryCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let translator = CSharpToGSharpTranslator()
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                repositoryCompilations,
                repositoryCompilations
            )
            let unit = translator.TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
