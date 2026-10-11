// <copyright file="Issue4412OverloadCallbackSelfMigrationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #4412: the hidden-parameter callback remains self-migratable.</summary>
/// <remarks>
/// ADR-0154 witness: changing the callback input from <c>MethodBase</c> back to
/// the resolver's <c>T</c> breaks the signature assertion and reproduces the
/// MethodInfo/ConstructorInfo call-site binding failure in the round-trip test.
/// </remarks>
public sealed class Issue4412OverloadCallbackSelfMigrationTests
{
    [Fact]
    public void MethodBaseCallback_MethodAndConstructorCallsRoundTrip()
    {
        const string source = """
            using System;
            using System.Reflection;

            public static class Resolver
            {
                public static T Resolve<T>(
                    T candidate,
                    Func<MethodBase, int>? trailingParameterCountToIgnore = null)
                    where T : MethodBase =>
                    candidate;

                public static MethodInfo ResolveMethod(MethodInfo candidate) =>
                    Resolve(candidate, static member => member is MethodInfo ? 1 : 0);

                public static ConstructorInfo ResolveConstructor(ConstructorInfo candidate) =>
                    Resolve(candidate, static member => member is ConstructorInfo ? 1 : 0);
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        // Formerly asserted against the real ClrOverloadResolution.cs; the pinned
        // shape is this declaration (a Func<MethodBase, int> callback on a method
        // generic over T : MethodBase), so the assertion lives on the snippet and
        // survives the compiler sources becoming G# (#4661).
        string compact = string.Concat(printed.Where(character => !char.IsWhiteSpace(character)));
        Assert.Contains(
            "trailingParameterCountToIgnore((MethodBase)->int32)?=nil",
            compact,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "trailingParameterCountToIgnore((T)->int32)?",
            compact,
            StringComparison.Ordinal);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);

        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
    }
}
