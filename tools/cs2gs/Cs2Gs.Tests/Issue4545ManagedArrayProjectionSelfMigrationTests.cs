// <copyright file="Issue4545ManagedArrayProjectionSelfMigrationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4545ManagedArrayProjectionSelfMigrationTests
{
    [Fact]
    public async Task ProjectionStateTranslatesWithExplicitNullableStorage()
    {
        // The state file and its owner (DocumentTranslationState) are pinned as
        // frozen C# snapshots (#4661), so the translator regression they guard
        // survives the compiler becoming G#.
        string[] snapshots = { "DocumentTranslationState", "ManagedReferenceArrayNullableState" };
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            snapshots.Select(name => (name + ".cs", FrozenCompilerSnapshots.Read(name + ".cs.txt"))).ToArray());
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(2, project.Documents.Count);
        var translatedByName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            translatedByName[Path.GetFileNameWithoutExtension(document.FilePath)] = GSharpPrinter.Print(
                new CSharpToGSharpTranslator(preservePartialParts: true)
                    .TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, d => d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId);
        }

        Assert.Contains(
            "ManagedReferenceArrayNullable",
            SelfMigratedCompilerSource.Compact(translatedByName["DocumentTranslationState"]),
            StringComparison.Ordinal);
        string translatedState = translatedByName["ManagedReferenceArrayNullableState"];

        string state = translatedState
            .Replace(
                "Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax",
                "ExpressionSyntax",
                StringComparison.Ordinal);
        Assert.Contains(
            "Dictionary[ExpressionSyntax, ITypeSymbol?]",
            state,
            StringComparison.Ordinal);
        Assert.Contains(
            "Dictionary[ITypeSymbol, GTypeReference?]",
            state,
            StringComparison.Ordinal);
        Assert.Contains(
            "Dictionary[ILocalSymbol, ITypeSymbol?]",
            state,
            StringComparison.Ordinal);
        Assert.Contains(
            "Dictionary[ExpressionSyntax, IMethodSymbol?]",
            state,
            StringComparison.Ordinal);
        Assert.Contains(
            "[length]NullableTypeSymbolSlot",
            state,
            StringComparison.Ordinal);
        Assert.Contains(
            "HasValue",
            state,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "prop this[index int32]",
            state,
            StringComparison.Ordinal);

        // The Invocations half guards the committed translator source itself: its
        // G# is translated from the C# until the cut-over and is the committed
        // .gs afterwards (#4661). Whitespace-insensitive, since layout differs.
        IReadOnlyDictionary<string, SelfMigratedCompilerSource.MigratedFile> own =
            await SelfMigratedCompilerSource.LoadAsync(
                "tools/cs2gs/Cs2Gs.Translator",
                preservePartialParts: true,
                "CSharpToGSharpTranslator.Invocations");
        Assert.DoesNotContain(
            own["CSharpToGSharpTranslator.Invocations"].Diagnostics,
            d => d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId);
        string invocations = SelfMigratedCompilerSource.Compact(own["CSharpToGSharpTranslator.Invocations"].Text);
        int recordTypeParameters =
            invocations.IndexOf("letRecordWidenedTypeParameters", StringComparison.Ordinal);
        int recordArguments =
            invocations.IndexOf("letRecordWidenedArguments", StringComparison.Ordinal);
        Assert.True(recordTypeParameters >= 0);
        Assert.True(recordArguments > recordTypeParameters);
        Assert.Contains("NullableTypeSymbolSlots(method.TypeArguments.Length)", invocations, StringComparison.Ordinal);
        Assert.Contains("ifmember==nil", invocations, StringComparison.Ordinal);
        Assert.Contains("RecordContainingTypeArgument(", invocations, StringComparison.Ordinal);
        Assert.Contains("lettupleElement", invocations, StringComparison.Ordinal);
        Assert.DoesNotContain("RecordContainingTypeArgument(member.ContainingType", invocations, StringComparison.Ordinal);
    }
}
