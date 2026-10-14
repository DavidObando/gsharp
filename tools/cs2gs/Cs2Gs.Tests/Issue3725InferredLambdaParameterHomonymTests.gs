// <copyright file="Issue3725InferredLambdaParameterHomonymTests.cs" company="GSharp">
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
import System.IO
import System.Linq
import Xunit

/// Issue #3725 (#3724 family B): a lambda parameter is the one type position
/// cs2gs manufactures — C# infers it from the delegate target and writes no
/// name at all, while the canonical G# arrow lambda always spells it
/// (ADR-0074). The #2222/#3554 homonym check that decides whether a bare type
/// name is safe consulted a purely SYNTACTIC pre-scan of the file's name
/// nodes, so a namespace reached only through such an inferred parameter type
/// was invisible to it even though the translator still synthesized an
/// `import` for it.
///
/// In `test/LanguageServer.Tests/DocumentSyncHandlerTests.cs` that meant
/// `GSharp.Core.CodeAnalysis.Diagnostic` and
/// `GSharp.LanguageServer.Protocol.Diagnostic` — both reached only
/// through `d => d.Message…` lambdas — both printed bare while both
/// namespaces were imported. gsc resolves a bare imported type name by
/// first-import-wins with no ambiguity report, so every Protocol-typed lambda
/// silently bound the Core type and the enclosing generic call failed
/// inference with `GS0159 Cannot find function DoesNotContain`/`Where`.
open class Issue3725InferredLambdaParameterHomonymTests {
    @Fact
    func InferredLambdaParameter_QualifiesTheHomonymReachedOnlyThroughInference() {
        let rendered = Translate(HomonymTestsSource)
        Assert.Contains("(d Corpus.Issue3725.Protocol.Diagnostic) ->", rendered, StringComparison.Ordinal)
        Assert.Contains("(d Corpus.Issue3725.Core.Diagnostic) ->", rendered, StringComparison.Ordinal)
    }

    @Fact
    func InferredLambdaParameter_LeavesNoBareHomonymSpelling() {
        // The bare spelling is what gsc silently mis-binds; neither lambda may
        // keep it once both namespaces are imported.
        Assert.DoesNotContain("(d Diagnostic) ->", Translate(HomonymTestsSource), StringComparison.Ordinal)
    }

    @Fact
    func InferredLambdaParameter_WithoutHomonym_StaysBare() {
        // Guard rail: the widened pre-scan only ADDS namespaces the homonym
        // check may consider — a lambda parameter whose type has no same-named
        // sibling in another imported namespace must still print bare, or the
        // fix would qualify the whole corpus.
        let rendered = Translate(SingleTypeTestsSource)
        Assert.Contains("(d Diagnostic) ->", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Corpus.Issue3725.Protocol.Diagnostic", rendered, StringComparison.Ordinal)
    }

    shared {
        /// The referenced-assembly shape: two namespaces declaring the same simple
        /// type name, reachable from the test file only through inference. Both
        /// live in METADATA, so the compilation-wide source census
        /// (`HasSourceHomonym`) cannot see the collision either.
        private const LibrarySource string = `
using System.Collections.Generic;

namespace Corpus.Issue3725.Core
{
    public sealed class Diagnostic { public string Message { get; set; } }

    public sealed class Scope { public IReadOnlyList<Diagnostic> Diagnostics { get; set; } }

    public sealed class Compilation { public Scope GlobalScope { get; set; } }
}

namespace Corpus.Issue3725.Protocol
{
    public sealed class Diagnostic { public string Message { get; set; } }
}

namespace Corpus.Issue3725.Server
{
    public sealed class Result { public IReadOnlyList<Protocol.Diagnostic> Diagnostics { get; set; } }

    public static class Handler
    {
        public static Result Compute() => null;

        public static Core.Compilation Bind() => null;
    }
}
`

        private const HomonymTestsSource string = `
using System.Linq;
using Corpus.Issue3725.Server;

namespace Corpus.Issue3725.Tests
{
    public class Probe
    {
        public void M()
        {
            var protocolDiagnostics = Handler.Compute().Diagnostics;
            var coreDiagnostics = Handler.Bind().GlobalScope.Diagnostics;

            var a = protocolDiagnostics.Where(d => d.Message.Length > 0).ToList();
            var b = coreDiagnostics.Where(d => d.Message.Length > 0).ToList();
        }
    }
}
`

        private const SingleTypeTestsSource string = `
using System.Linq;
using Corpus.Issue3725.Server;

namespace Corpus.Issue3725.Tests
{
    public class Probe
    {
        public void M()
        {
            var protocolDiagnostics = Handler.Compute().Diagnostics;

            var a = protocolDiagnostics.Where(d => d.Message.Length > 0).ToList();
        }
    }
}
`

        private func Translate(testsSource string) string {
            let runtime = CSharpProjectLoader.RuntimeReferences()
            let library = CSharpCompilation.Create(
                "Corpus.Issue3725.Library",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                runtime,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let peStream = MemoryStream()
            let emit = library.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            let references = List[MetadataReference](runtime){MetadataReference.CreateFromStream(peStream)}
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, testsSource string){("Tests.cs", testsSource)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
