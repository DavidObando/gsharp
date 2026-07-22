// <copyright file="Issue2743NullableObjectInitializerWideningTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2743NullableObjectInitializerWideningTranslationTests
{
    private const string Source = """
        #nullable enable
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
        }
        """;

    [Fact]
    public void Dictionary_NullableReferenceWidening_PreservesNull()
    {
        string translated = Compact(Translate());

        Assert.Contains("[\"value\"] = config.Value", translated, StringComparison.Ordinal);
        Assert.Contains("\"value\": config.Value", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("config.Value!!", NullableDictionarySection(translated), StringComparison.Ordinal);
    }

    [Fact]
    public void Dictionary_ConditionalAccessWidening_PreservesNull()
    {
        string translated = NullableDictionarySection(Compact(Translate()));

        Assert.Contains("config.Value?.ToString()", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("ToString()!!", translated, StringComparison.Ordinal);
    }

    [Fact]
    public void Dictionary_GenericNullableReferenceWidening_PreservesNull()
    {
        string translated = NullableDictionarySection(Compact(Translate()));

        Assert.Contains("Maybe[string]()", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("Maybe[string]()!!", translated, StringComparison.Ordinal);
    }

    [Fact]
    public void Collection_NullableElements_PreserveNull()
    {
        string translated = Compact(Translate());
        string collection = translated[
            translated.IndexOf("func Collection", StringComparison.Ordinal)..
            translated.IndexOf("func RequiredDictionary", StringComparison.Ordinal)];

        Assert.Contains(
            "List[object?]{ config.Value, config.Value?.ToString(), Maybe[string]() }",
            collection,
            StringComparison.Ordinal);
        Assert.DoesNotContain("!!", collection, StringComparison.Ordinal);
    }

    [Fact]
    public void RequiredDictionaryAndCollection_RetainAssertions()
    {
        string translated = Compact(Translate());

        Assert.Contains(
            "Dictionary[string, object]{ [\"value\"] = config.Value!! }",
            translated,
            StringComparison.Ordinal);
        Assert.Contains("List[string]{ config.Value!! }", translated, StringComparison.Ordinal);
    }

    private static string NullableDictionarySection(string translated) =>
        translated[
            translated.IndexOf("func Dictionary", StringComparison.Ordinal)..
            translated.IndexOf("func RequiredDictionary", StringComparison.Ordinal)];

    private static string Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Repro.cs", Source) },
            CSharpProjectLoader.RuntimeReferences(),
            "Issue2743");
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document));
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
        return printed;
    }

    private static string Compact(string value) =>
        string.Join(
            " ",
            value.Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
}
