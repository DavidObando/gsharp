// <copyright file="Issue1567CollectionInitializerObjectInitTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Linq
import System.Text.Json
import Xunit

/// Translator-fidelity tests for issue #1567 — a C# collection initializer
/// nested inside an object initializer, e.g. `new T { Prop = { a, b } }`,
/// which populates a GET-ONLY collection property by lowering to
/// `receiver.Prop.Add(a); receiver.Prop.Add(b);` rather than assigning.
///
/// cs2gs must emit the target-less braced member form
/// `T{ Prop: { a, b } }` (a (cref:CollectionInitializerExpression)
/// with a null Target) so gsc lowers to Add calls on the get-only property
/// instead of reporting GS0127. The previously-emitted array-literal form
/// (`Prop: []object{...}`) both hit GS0127 and dropped dictionary keys.
open class Issue1567CollectionInitializerObjectInitTranslationTests {
    @Fact
    func GetOnlyCollectionProperty_EmitsBracedMemberInitializer() {
        let printed = TranslateUnit(`
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Demo
{
    public class C
    {
        public JsonSerializerOptions Make() => new JsonSerializerOptions
        {
            WriteIndented = true,
            Converters = { new JsonStringEnumConverter() },
        };
    }
}`, MetadataReference.CreateFromFile(typeof(JsonSerializerOptions).Assembly.Location))
        // Braced member form, not an array-literal assignment.
        Assert.Contains("Converters: {", printed)
        Assert.DoesNotContain("Converters: []", printed)
        // The settable scalar member keeps a normal assignment form.
        Assert.Contains("WriteIndented: true", printed)
    }

    @Fact
    func ProcessStartInfoArgumentList_EmitsBracedMemberInitializer() {
        let printed = TranslateUnit(`
using System.Diagnostics;

namespace Demo
{
    public class C
    {
        public ProcessStartInfo Make(string path) => new ProcessStartInfo
        {
            FileName = "explorer.exe",
            ArgumentList = { path },
        };
    }
}`)
        Assert.Contains("ArgumentList: {", printed)
        Assert.DoesNotContain("ArgumentList: []", printed)
        Assert.Contains("FileName: ", printed)
    }

    @Fact
    func GetOnlyDictionaryProperty_PreservesKeysInBracedForm() {
        // A dictionary collection-initializer inside an object initializer must
        // keep its keys — the old array-literal path dropped them.
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public class Holder
    {
        public Dictionary<string, int> Map { get; } = new();
    }

    public class C
    {
        public Holder Make() => new Holder
        {
            Map = { ["a"] = 1, ["b"] = 2 },
        };
    }
}`)
        Assert.Contains("Map: {", printed)
        Assert.DoesNotContain("Map: []", printed)
        Assert.Contains("\"a\"", printed)
        Assert.Contains("\"b\"", printed)
    }

    shared {
        private func TranslateUnit(source string, additionalReferences ...MetadataReference) string {
            let references IReadOnlyList[MetadataReference]? = if additionalReferences.Length == 0 {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy((reference MetadataReference) -> reference.Display!!, StringComparer.Ordinal)
                    .Select((group IGrouping[string, MetadataReference]) -> group.First())
                    .ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
