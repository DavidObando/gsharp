// <copyright file="Issue4704ForwardedWarningIdTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Threading.Tasks
import Xunit

/// Issue #4704: the self-migrated Translate stage threw a
/// `NullReferenceException` on the first translation warning without a
/// diagnostic id. `TranslationDiagnostic.DiagnosticId` can be null, and
/// the pipeline's warning predicate must compare it without a fail-fast `!!`.
open class Issue4704ForwardedWarningIdTests {
    /// The discriminating witness (ADR-0154): translate the repository's real
    /// TranslateStage.cs with the Translator project as a sibling compilation.
    /// The old implementation emitted DiagnosticId!! here, which throws on a
    /// warning without an explicit id.
    @Fact
    async func TranslateStageSelfMigration_DoesNotAssertDiagnosticId() {
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        let pipeline = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "tools", "cs2gs", "Cs2Gs.Pipeline", "Cs2Gs.Pipeline.csproj")
        )
        let translator = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "tools", "cs2gs", "Cs2Gs.Translator", "Cs2Gs.Translator.csproj")
        )
        Assert.True(
            pipeline.BoundWithoutErrors,
            "Cs2Gs.Pipeline should bind with no C# errors: " + string.Join(
                Environment.NewLine,
                pipeline.ErrorDiagnostics
            )
        )
        Assert.True(
            translator.BoundWithoutErrors,
            "Cs2Gs.Translator should bind with no C# errors: " + string.Join(
                Environment.NewLine,
                translator.ErrorDiagnostics
            )
        )
        let document = Assert.Single(
            pipeline.Documents,
            (candidate LoadedDocument) -> Path.GetFileName(candidate.FilePath) == "TranslateStage.cs"
        )
        let siblings = []CSharpCompilation{pipeline.Compilation, translator.Compilation}
        let context = TranslationContext(
            pipeline.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblings,
            repositoryCompilations: siblings
        )
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context)
        )
        Assert.Contains("IsForwardedTranslationWarning", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("DiagnosticId!!", printed, StringComparison.Ordinal)
    }
}
