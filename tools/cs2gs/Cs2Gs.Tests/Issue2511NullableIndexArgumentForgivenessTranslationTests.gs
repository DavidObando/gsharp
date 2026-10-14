// <copyright file="Issue2511NullableIndexArgumentForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

/// Regression coverage for issue #2511: nullable-oblivious values used as
/// index arguments need the same minimal, target-aware forgiveness as ordinary
/// call arguments.
class Issue2511NullableIndexArgumentForgivenessTranslationTests {
    @Fact
    func ObliviousDictionaryIndexes_ForgiveReadsWritesAndCompoundAssignments() {
        let printed = TranslateOblivious(`using System;
using System.Collections.Generic;

namespace Demo;

public static class Repro
{
    private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

    public static string Run(
        Dictionary<string, string> items,
        Dictionary<string, int> counts)
    {
        string key = FindKey();
        items[key] = "value";
        string value = items[key];
        counts[key] += 1;
        counts[key]++;
        items[FindKey()] ??= value;
        Dictionary<string, string> initialized = new()
        {
            [key] = value,
        };
        return items[key];
    }
}`, "G# rejects ??= on the oblivious Dictionary value because its indexer type is non-nullable.")
        Assert.Contains("items[key!!] = \"value\"", printed, StringComparison.Ordinal)
        Assert.Contains("let value = items[key!!]", printed, StringComparison.Ordinal)
        Assert.Contains("counts[key!!] += 1", printed, StringComparison.Ordinal)
        Assert.Contains("counts[key!!]++", printed, StringComparison.Ordinal)
        Assert.Contains("items[FindKey()!!] ??= value", printed, StringComparison.Ordinal)
        Assert.Contains("[key!!] = value", printed, StringComparison.Ordinal)
        Assert.Contains("return items[key!!]", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "items[FindKey()!!]"))
    }

    @Fact
    func ImportedGenericAndConditionalIndexes_AreForgivenWithoutDoubleAssertion() {
        let printed = TranslateObliviousWithIndexerLibrary(`using System;

namespace Demo;

public static class Repro
{
    private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

    public static string Run(
        ImportedLookup imported,
        GenericLookup<string> generic,
        bool useConditional)
    {
        string key = FindKey();
        imported[key] = "value";
        string first = imported[key];
        string second = generic[key];
        string third = imported[key!];
        string fourth = useConditional ? imported?[key] : "";
        return first + second + third + fourth;
    }
}`)
        // Issue #3865: the RECEIVER assertions stay — `imported` is a value read
        // whose imported oblivious type gsc maps to `T?`, so `imported!!` is
        // what makes the indexer access bind at all. The KEY assertions are
        // gone: `ImportedLookup.this[string key]` is declared in a
        // `#nullable disable` region, so gsc imports the parameter as `string?`
        // and it accepts a nullable key with no bridge. `!!` is a RUNTIME check
        // in G#, so asserting there turned a legal null key into a throw.
        // `Issue3865ImportedObliviousArgumentAssertionTests` compiles and RUNS
        // this exact shape to prove the removal is gratuitous, not lost
        // checking. `GenericLookup<TKey>.this[TKey key]` declares a TYPE
        // PARAMETER, which carries no obliviousness signal, so its key keeps the
        // assertion — the control that pins the exclusion.
        Assert.Contains("imported!![key] = \"value\"", printed, StringComparison.Ordinal)
        Assert.Contains("let first = imported!![key]", printed, StringComparison.Ordinal)
        Assert.Contains("let second = generic[key!!]", printed, StringComparison.Ordinal)
        // `third` reads `imported[key!]` — a USER-AUTHORED C# suppression, which
        // is preserved as `!!` regardless of the target contract.
        Assert.Contains("let third = imported!![key!!]", printed, StringComparison.Ordinal)
        Assert.Contains("imported?[key]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("key!!!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func ObliviousIndexArgumentShapes_ReuseValueForgiveness() {
        let printed = TranslateOblivious(`using System;
using System.Collections.Generic;

namespace Demo;

public sealed class Holder
{
    public string Key { get; set; }
}

public static class Repro
{
    private static string Field = Environment.GetEnvironmentVariable("FIELD");
    private static string Property => Environment.GetEnvironmentVariable("PROPERTY");
    private static string FindKey() => Environment.GetEnvironmentVariable("METHOD");

    public static void Run(
        Dictionary<string, string> items,
        string parameter,
        Holder holder,
        bool choose)
    {
        parameter = Environment.GetEnvironmentVariable("PARAMETER");
        items[Field] = "field";
        items[Property] = "property";
        items[FindKey()] = "method";
        items[parameter] = "parameter";
        items[choose ? Field : Property] = "conditional";
        items[holder?.Key] = "conditional-access";
        items[Environment.GetEnvironmentVariable("DIRECT")] = "external";
    }
}`)
        Assert.Contains("items[Field!!] = \"field\"", printed, StringComparison.Ordinal)
        Assert.Contains("items[Property!!] = \"property\"", printed, StringComparison.Ordinal)
        Assert.Contains("items[FindKey()!!] = \"method\"", printed, StringComparison.Ordinal)
        Assert.Contains("items[parameter!!] = \"parameter\"", printed, StringComparison.Ordinal)
        Assert.Contains("if choose { Field } else { Property }", printed, StringComparison.Ordinal)
        Assert.Contains("Property })!!] = \"conditional\"", printed, StringComparison.Ordinal)
        Assert.Contains("items[(holder?.Key)!!] = \"conditional-access\"", printed, StringComparison.Ordinal)
        Assert.Contains(
            "items[Environment.GetEnvironmentVariable(\"DIRECT\")!!] = \"external\"",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ExplicitNullableIndexContractsRemainBareAndGuardedNonNullContractsCompile() {
        let oblivious = TranslateObliviousWithIndexerLibrary(`using System;

namespace Demo;

public sealed class SourceLookup
{
    public string this[string key]
    {
        get => key;
        set { }
    }
}

public static class Repro
{
    private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

    public static string Run(
        NullableLookup nullable,
        SourceLookup source)
    {
        string key = FindKey();
        nullable[key] = "value";
        source[key] = "value";
        NullableLookup initialized = new()
        {
            [key] = "value",
        };
        return nullable[key] + source[key];
    }
}`)
        Assert.Contains("nullable[key] = \"value\"", oblivious, StringComparison.Ordinal)
        Assert.Contains("nullable[key] + source[key]", oblivious, StringComparison.Ordinal)
        Assert.DoesNotContain("nullable[key!!]", oblivious, StringComparison.Ordinal)
        Assert.DoesNotContain("source[key!!]", oblivious, StringComparison.Ordinal)
        Assert.DoesNotContain("[key!!] = \"value\"", oblivious, StringComparison.Ordinal)
        let enabled = Translate(`#nullable enable
using System.Collections.Generic;

namespace Demo;

public static class Repro
{
    public static string Run(Dictionary<string, string> items, string? key)
    {
        if (key is null)
        {
            return "";
        }

        return items[key];
    }
}`, NullableContextOptions.Enable)
        Assert.Contains("return items[key]", enabled, StringComparison.Ordinal)
        Assert.DoesNotContain("key!!", enabled, StringComparison.Ordinal)
    }

    @Fact
    func GuardsExpressionTreesAndNumericIndexPaths_RemainUnchanged() {
        let printed = TranslateOblivious(`using System;
using System.Collections.Generic;
using System.Linq.Expressions;

namespace Demo;

public static class Repro
{
    private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

    public static int Run(
        Dictionary<string, string> items,
        int[] array,
        int[,] grid,
        string text,
        int i,
        int row,
        int column)
    {
        string key = FindKey();
        if (key != null)
        {
            _ = items[key];
        }

        items[key != null ? key : "fallback"] = "guarded";
        Expression<Func<Dictionary<string, string>, string>> read =
            dictionary => dictionary[key];
        Span<int> span = array;
        return array[i] + span[i] + text[i] + array[^1]
            + text[1..^1].Length + grid[row, column];
    }
}`, "Expression-tree index arguments deliberately retain nullable references that G# cannot bind to string.")
        Assert.Contains("items[key]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("key!!", printed, StringComparison.Ordinal)
        Assert.Contains("dictionary[key]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("dictionary[key!!]", printed, StringComparison.Ordinal)
        Assert.Contains("array[i]", printed, StringComparison.Ordinal)
        Assert.Contains("span[i]", printed, StringComparison.Ordinal)
        Assert.Contains("text[i]", printed, StringComparison.Ordinal)
        Assert.Contains("array[^1]", printed, StringComparison.Ordinal)
        Assert.Contains("text[1..^1]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("row!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("column!!", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateOblivious(source string, roundTripOnlyReason string? = nil) string -> Translate(
            source,
            NullableContextOptions.Disable,
            roundTripOnlyReason
        )

        private func Translate(
            source string,
            nullableContext NullableContextOptions,
            additionalReferences ...MetadataReference
        ) string -> Translate(source, nullableContext, roundTripOnlyReason: nil, additionalReferences)

        private func Translate(
            source string,
            nullableContext NullableContextOptions,
            roundTripOnlyReason string?,
            additionalReferences ...MetadataReference
        ) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Issue2511.Consumer",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Concat(additionalReferences),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    nullableContext
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(translated)
            let roundTrip RoundTripResult? = if roundTripOnlyReason != nil {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            } else {
                (
                    if additionalReferences.Length == 0 {
                        TranslationTestValidation.AssertBinds(printed)
                    } else {
                        TranslationTestValidation.ValidateRoundTripOnly(
                            printed,
                            "Consumer-only fixture omits the referenced indexer metadata library from emitted G#."
                        )
                    }
                )
            }
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func TranslateObliviousWithIndexerLibrary(source string) string -> Translate(
            source,
            NullableContextOptions.Disable,
            CompileIndexerLibrary()
        )

        private func CompileIndexerLibrary() MetadataReference {
            const source = `#nullable disable
public sealed class ImportedLookup
{
    public string this[string key]
    {
        get => key;
        set { }
    }
}

public sealed class GenericLookup<TKey>
    where TKey : class
{
    public string this[TKey key] => key.ToString();
}

#nullable enable
public sealed class NullableLookup
{
    public string this[string? key]
    {
        get => key ?? "";
        set { }
    }
}`
            let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let compilation = CSharpCompilation.Create(
                "Issue2511.IndexerLibrary",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return MetadataReference.CreateFromImage(stream.ToArray())
        }

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            for var index = text.IndexOf(value, StringComparison.Ordinal); index >= 0; index = text.IndexOf(
                value,
                index + value.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }
    }
}
