// <copyright file="Issue4833NullableTupleValueTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4833NullableTupleValueTranslationTests
{
    [Fact]
    public void NullableReturnStoredInDictionaryTupleValue_PromotesMatchingElement()
    {
        const string source = """
            using System.Collections.Generic;

            public static class Probe
            {
                private static string AttributeConstant(bool present)
                {
                    if (present)
                    {
                        return "value";
                    }

                    return null;
                }

                public static void Run()
                {
                    var values = new Dictionary<int, (string Name, string Default)>();
                    string fallback = AttributeConstant(false);
                    values[0] = ("arg", fallback);

                    if (!values.TryGetValue(1, out (string Name, string Default) value))
                    {
                        value = ("missing", null);
                    }
                }
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Issue4833.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains(
            "Dictionary[int32, (Name string, Default string?)]",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "func AttributeConstant(present bool) string?",
            printed,
            StringComparison.Ordinal);

        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:\n"
                + string.Join("\n", result.Errors)
                + "\n\nPrinted:\n"
                + printed);
    }
}
