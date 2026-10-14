// <copyright file="Issue2743NullableObjectInitializerWideningTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

class Issue2743NullableObjectInitializerWideningTranslationTests {
    @Fact
    func Dictionary_NullableReferenceWidening_PreservesNull() {
        let translated = Compact(Translate())
        Assert.Contains("[\"value\"] = config.Value", translated, StringComparison.Ordinal)
        Assert.Contains("\"value\": config.Value", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("config.Value!!", NullableDictionarySection(translated), StringComparison.Ordinal)
    }

    @Fact
    func Dictionary_ConditionalAccessWidening_PreservesNull() {
        let translated = NullableDictionarySection(Compact(Translate()))
        Assert.Contains("config.Value?.ToString()", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("ToString()!!", translated, StringComparison.Ordinal)
    }

    @Fact
    func Dictionary_GenericNullableReferenceWidening_PreservesNull() {
        let translated = NullableDictionarySection(Compact(Translate()))
        Assert.Contains("Maybe[string]()", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("Maybe[string]()!!", translated, StringComparison.Ordinal)
    }

    @Fact
    func Collection_NullableElements_PreserveNull() {
        let translated = Compact(Translate())
        let collection = translated[
            translated.IndexOf("func Collection", StringComparison.Ordinal) .. translated.IndexOf(
                "func RequiredDictionary",
                StringComparison.Ordinal
            )
        ]
        Assert.Contains(
            "List[object?]{ config.Value, config.Value?.ToString(), Maybe[string]() }",
            collection,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("!!", collection, StringComparison.Ordinal)
    }

    @Fact
    func RequiredDictionaryAndCollection_RetainAssertions() {
        let translated = Compact(Translate())
        Assert.Contains(
            "Dictionary[string, object]{ [\"value\"] = config.Value!! }",
            translated,
            StringComparison.Ordinal
        )
        Assert.Contains("List[string]{ config.Value!! }", translated, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `#nullable enable
using System.Collections.Generic;

namespace Issue2743;

public sealed class Config
{
    public string? Value { get; set; }
}

public static class Repro
{
    private static T? Maybe<T>() where T : class => null;

    public static Dictionary<string, object?> Dictionary(Config config) =>
        new Dictionary<string, object?>
        {
            ["value"] = config.Value,
            ["conditional"] = config.Value?.ToString(),
            ["generic"] = Maybe<string>(),
        };

    public static Dictionary<string, object?> KeyedDictionary(Config config) =>
        new Dictionary<string, object?> { { "value", config.Value } };

    public static List<object?> Collection(Config config) =>
        new List<object?> { config.Value, config.Value?.ToString(), Maybe<string>() };

    public static Dictionary<string, object> RequiredDictionary(Config config) =>
        new Dictionary<string, object> { ["value"] = config.Value };

    public static List<string> RequiredCollection(Config config) =>
        new List<string> { config.Value };
}`

        private func NullableDictionarySection(translated string) string -> translated[
            translated.IndexOf("func Dictionary", StringComparison.Ordinal) .. translated.IndexOf(
                "func RequiredDictionary",
                StringComparison.Ordinal
            )
        ]

        private func Translate() string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, Source string){("Repro.cs", Source)},
                CSharpProjectLoader.RuntimeReferences(),
                "Issue2743"
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document))
            let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "G# currently requires a Dictionary constructor argument before binding collection initializer entries."
            )
            Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
            return printed
        }

        private func Compact(value string) string -> string.Join(
            " ",
            value.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
