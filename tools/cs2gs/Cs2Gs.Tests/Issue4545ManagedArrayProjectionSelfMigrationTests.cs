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
    public async Task CoreConditionalWithProjectedSubtypeAndCommonBaseTranslates()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "src", "Core", "Core.csproj"));
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(
            project.Documents,
            candidate => candidate.FilePath.EndsWith(
                Path.Combine("Emit", "SlotPlanner.cs"),
                StringComparison.Ordinal));
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);

        new CSharpToGSharpTranslator(preservePartialParts: true)
            .TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Message.Contains(
                "conditional/switch result arms have incompatible managed-reference projections",
                StringComparison.Ordinal));
    }

    [Fact]
    public async Task ProjectionStateTranslatesWithExplicitNullableStorage()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(
                repoRoot,
                "tools",
                "cs2gs",
                "Cs2Gs.Translator",
                "Cs2Gs.Translator.csproj"));
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translated = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string fileName in new[]
                 {
                     "DocumentTranslationState.cs",
                     "ManagedReferenceArrayNullableState.cs",
                     "CSharpToGSharpTranslator.Invocations.cs",
                 })
        {
            LoadedDocument document = Assert.Single(
                project.Documents,
                candidate => candidate.FilePath.EndsWith(fileName, StringComparison.Ordinal));
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            translated[fileName] = GSharpPrinter.Print(
                new CSharpToGSharpTranslator(preservePartialParts: true)
                    .TranslateDocument(document, context));
            Assert.Empty(context.Diagnostics);
        }

        string state = translated["ManagedReferenceArrayNullableState.cs"];
        Assert.Contains(
            "Dictionary[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, ITypeSymbol?]",
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
            "Dictionary[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, IMethodSymbol?]",
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

        string invocations = translated["CSharpToGSharpTranslator.Invocations.cs"];
        int recordTypeParameters =
            invocations.IndexOf("let RecordWidenedTypeParameters", StringComparison.Ordinal);
        int recordArguments =
            invocations.IndexOf("let RecordWidenedArguments", StringComparison.Ordinal);
        Assert.True(recordTypeParameters >= 0);
        Assert.True(recordArguments > recordTypeParameters);
        Assert.Contains(
            "NullableTypeSymbolSlots(method.TypeArguments.Length)",
            invocations,
            StringComparison.Ordinal);
        Assert.Contains(
            "if member == nil",
            invocations,
            StringComparison.Ordinal);
        Assert.Contains(
            "RecordContainingTypeArgument(",
            invocations,
            StringComparison.Ordinal);
        Assert.Contains(
            "let tupleElement",
            invocations,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "RecordContainingTypeArgument(member.ContainingType",
            invocations,
            StringComparison.Ordinal);
    }
}
