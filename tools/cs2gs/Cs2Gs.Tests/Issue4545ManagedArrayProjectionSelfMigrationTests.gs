// <copyright file="Issue4545ManagedArrayProjectionSelfMigrationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue4545ManagedArrayProjectionSelfMigrationTests {
    @Fact
    async func ProjectionStateTranslatesWithExplicitNullableStorage() {
        // The state file and its owner (DocumentTranslationState) are pinned as
        // frozen C# snapshots (#4661), so the translator regression they guard
        // survives the compiler becoming G#.
        let snapshots[]string = []string{"DocumentTranslationState", "ManagedReferenceArrayNullableState"}
        let project = CSharpProjectLoader.LoadInMemory(
            snapshots.Select((name string) -> (name + ".cs", FrozenCompilerSnapshots.Read(name + ".cs.txt"))).ToArray()
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        Assert.Equal(2, project.Documents.Count)
        let translatedByName = Dictionary[string, string](StringComparer.Ordinal)
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            translatedByName[Path.GetFileNameWithoutExtension(document.FilePath)] = GSharpPrinter.Print(
                CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context)
            )
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            )
        }
        Assert.Contains(
            "ManagedReferenceArrayNullable",
            SelfMigratedCompilerSource.Compact(translatedByName["DocumentTranslationState"]),
            StringComparison.Ordinal
        )
        let translatedState = translatedByName["ManagedReferenceArrayNullableState"]
        let state = translatedState.Replace(
            "Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax",
            "ExpressionSyntax",
            StringComparison.Ordinal
        )
        Assert.Contains("Dictionary[ExpressionSyntax, ITypeSymbol?]", state, StringComparison.Ordinal)
        Assert.Contains("Dictionary[ITypeSymbol, GTypeReference?]", state, StringComparison.Ordinal)
        Assert.Contains("Dictionary[ILocalSymbol, ITypeSymbol?]", state, StringComparison.Ordinal)
        Assert.Contains("Dictionary[ExpressionSyntax, IMethodSymbol?]", state, StringComparison.Ordinal)
        Assert.Contains("[length]NullableTypeSymbolSlot", state, StringComparison.Ordinal)
        Assert.Contains("HasValue", state, StringComparison.Ordinal)
        Assert.DoesNotContain("prop this[index int32]", state, StringComparison.Ordinal)
        // The Invocations half guards the committed translator source itself: its
        // G# is translated from the C# until the cut-over and is the committed
        // .gs afterwards (#4661). Whitespace-insensitive, since layout differs.
        let own = await SelfMigratedCompilerSource.LoadAsync(
            "tools/cs2gs/Cs2Gs.Translator",
            preservePartialParts: true,
            "CSharpToGSharpTranslator.Invocations"
        )
        Assert.DoesNotContain(
            own["CSharpToGSharpTranslator.Invocations"].Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
        let invocations = SelfMigratedCompilerSource.Compact(own["CSharpToGSharpTranslator.Invocations"].Text)
        let recordTypeParameters = invocations.IndexOf("letRecordWidenedTypeParameters", StringComparison.Ordinal)
        let recordArguments = invocations.IndexOf("letRecordWidenedArguments", StringComparison.Ordinal)
        Assert.True(recordTypeParameters >= 0)
        Assert.True(recordArguments > recordTypeParameters)
        Assert.Contains("NullableTypeSymbolSlots(method.TypeArguments.Length)", invocations, StringComparison.Ordinal)
        Assert.Contains("ifmember==nil", invocations, StringComparison.Ordinal)
        Assert.Contains("RecordContainingTypeArgument(", invocations, StringComparison.Ordinal)
        Assert.Contains("lettupleElement", invocations, StringComparison.Ordinal)
        Assert.DoesNotContain(
            "RecordContainingTypeArgument(member.ContainingType",
            invocations,
            StringComparison.Ordinal
        )
    }
}
