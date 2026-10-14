// <copyright file="Issue3805LinkedSourceHomonymTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #3805: a LINKED source — one `.cs` file compiled into several
/// projects via `<Compile Include="..\Shared\X.cs" />` — must
/// translate to the SAME G# in every project. The repository mirror writes one
/// `.gs` per source file and `TranslateStage` rejects divergent
/// renderings ("Linked source ... translates differently in multiple
/// projects").
///
/// The #1174 homonym census decides whether a bare type name is safe by
/// looking for a same-named type declared in SOURCE anywhere in the
/// compilation — and a project reference is a source-bearing compilation
/// reference, so the census follows the project's reference graph.
/// `test/Shared/EmittedOracle.cs` is linked into `test/Core.Tests`,
/// `tools/cs2gs/Cs2Gs.Tests` and `test/Interpreter.Tests`; only the
/// last references the Repl and through it
/// `GSharp.LanguageServer.Protocol.Diagnostic`. Its inferred lambda
/// parameter therefore printed `(d GSharp.Core.CodeAnalysis.Diagnostic)`
/// while the other two printed `(d Diagnostic)`, and the whole-repository
/// translate stage failed.
///
/// The rule adopted here is the one the shared-document nullability taint
/// already follows (issue #3501): a decision that can differ between the
/// projects linking a file is answered over the WHOLE set of them, converged
/// and order-independent. The qualified spelling binds in every project, so
/// the union answer is the safe one.
open class Issue3805LinkedSourceHomonymTests {
    @Fact
    func LinkedSource_TranslatesIdenticallyInEveryLinkingProject() {
        let (withoutHomonym, withHomonym) = TranslateBothProjects()
        // This is exactly what TranslateStage's cross-check compares.
        Assert.Equal(withoutHomonym, withHomonym)
    }

    @Fact
    func LinkedSource_QualifiesTheNameThatIsAmbiguousInAnyLinkingProject() {
        let (withoutHomonym, withHomonym) = TranslateBothProjects()
        // The qualified spelling binds in both projects; the bare one is the
        // spelling the census calls unsafe in the project that also sees
        // Corpus.Issue3805.Rival.Diagnostic.
        Assert.Contains("(d Corpus.Issue3805.Core.Diagnostic) ->", withHomonym, StringComparison.Ordinal)
        Assert.Contains("(d Corpus.Issue3805.Core.Diagnostic) ->", withoutHomonym, StringComparison.Ordinal)
        Assert.DoesNotContain("(d Diagnostic) ->", withoutHomonym, StringComparison.Ordinal)
    }

    @Fact
    func LinkedSource_WithNoHomonymAnywhere_StaysBare() {
        // Guard rail: the union answer must not qualify a name that is
        // unambiguous in EVERY linking project, or the fix would qualify the
        // whole corpus.
        let core = Reference("Corpus.Issue3805.Core", CoreLibrarySource)
        let first = LoadLinkingProject("Corpus.Issue3805.First", core)
        let second = LoadLinkingProject("Corpus.Issue3805.Second", core)
        let repository = []CSharpCompilation{first.Compilation, second.Compilation}
        let rendered = Translate(first, repository)
        Assert.Contains("(d Diagnostic) ->", rendered, StringComparison.Ordinal)
        Assert.Equal(rendered, Translate(second, repository))
    }

    shared {
        /// The type the linked file's lambda parameter is inferred as. Referenced
        /// by both projects.
        private const CoreLibrarySource string = `
using System.Collections.Generic;

namespace Corpus.Issue3805.Core
{
    public sealed class Diagnostic { public bool IsError { get; set; } }

    public sealed class EmitResult { public IReadOnlyList<Diagnostic> Diagnostics { get; set; } }
}
`

        /// The `GSharp.LanguageServer.Protocol` stand-in: a second
        /// `Diagnostic` in a namespace the linked file never imports and
        /// never names, referenced by only ONE of the linking projects.
        private const RivalLibrarySource string = `
namespace Corpus.Issue3805.Rival
{
    public sealed class Diagnostic { public bool IsError { get; set; } }
}
`

        /// The linked file. It never SPELLS `Diagnostic` — C# infers the
        /// lambda parameter's type — but G# always spells a lambda parameter's
        /// type (ADR-0074), so cs2gs has to choose a spelling.
        private const LinkedSource string = `
using System.Collections.Generic;
using System.Linq;
using Corpus.Issue3805.Core;

namespace Corpus.Issue3805.Tests
{
    public static class Oracle
    {
        public static int ErrorCount(EmitResult result)
        {
            return result.Diagnostics.Where(d => d.IsError).ToList().Count;
        }
    }
}
`

        /// The repo-relative path both projects link the file under. The two
        /// compilations parse it into distinct (cref:SyntaxTree) instances,
        /// so the linked-document set is matched by path and content.
        private const LinkedPath string = "test/Shared/Oracle.cs"

        /// Translates the linked file as each of the two linking projects, with
        /// the repository compilation set both of them would see in a
        /// whole-repository migration.
        /// @returns The rendering from the project without the rival type, then the one with it.
        private func TranslateBothProjects()(WithoutHomonym string, WithHomonym string) {
            let core = Reference("Corpus.Issue3805.Core", CoreLibrarySource)
            let rival = Reference("Corpus.Issue3805.Rival", RivalLibrarySource)
            let withoutHomonym = LoadLinkingProject("Corpus.Issue3805.WithoutHomonym", core)
            let withHomonym = LoadLinkingProject("Corpus.Issue3805.WithHomonym", core, rival)
            let repository = []CSharpCompilation{withoutHomonym.Compilation, withHomonym.Compilation}
            return (Translate(withoutHomonym, repository), Translate(withHomonym, repository))
        }

        /// A PROJECT reference: a compilation reference, whose types carry source
        /// locations exactly like an MSBuild `<ProjectReference>`'s do.
        /// That is what puts them in the #1174 source census, and what makes the
        /// census answer depend on the linking project's reference graph.
        /// @param assemblyName The referenced assembly name.
        /// @param source Its source.
        /// @returns The compilation reference.
        private func Reference(assemblyName string, source string) MetadataReference {
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            Assert.Empty(
                compilation.GetDiagnostics().Where(
                    (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
                )
            )
            return compilation.ToMetadataReference()
        }

        private func LoadLinkingProject(assemblyName string, extraReferences ...MetadataReference) LoadedCSharpProject {
            let references = List[MetadataReference](CSharpProjectLoader.RuntimeReferences())
            references.AddRange(extraReferences)
            let project = CSharpProjectLoader.LoadInMemory(
                [](LinkedPath string, LinkedSource string){(LinkedPath, LinkedSource)},
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
            return project
        }

        private func Translate(
            project LoadedCSharpProject,
            repositoryCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                repositoryCompilations,
                repositoryCompilations
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
