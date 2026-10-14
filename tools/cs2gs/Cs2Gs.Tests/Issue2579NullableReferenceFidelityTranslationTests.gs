// <copyright file="Issue2579NullableReferenceFidelityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

class Issue2579NullableReferenceFidelityTranslationTests {
    @Fact
    func NullableEnabledWarningBoundaries_EmitTargetAwareAssertions() {
        let printed = Translate(`#nullable enable
using System.Collections.Generic;
using System.Linq;

namespace Demo;

public sealed class Item
{
    public string Name => "item";
    public Item? Next => null;
}

public static class ItemExtensions
{
    public static string Label(this Item item) => item.Name;
    public static string NullableLabel(this Item? item) => item?.Name ?? "";
}

public static class Repro
{
    private static string Required = "";
    private static void Consume(string value) { }

    public static int Run(
        Item? item,
        IEnumerable<Item>? items,
        Dictionary<string, string> map,
        string? key)
    {
        _ = item.Name;
        _ = item.Next.Name;
        _ = item.Label();
        _ = item.NullableLabel();
        _ = items.Count();
        foreach (var current in items)
            _ = current.Name;

        string required = key;
        required = key;
        Required = key;
        Consume(key);
        _ = map[key];
        Consume(key!);
        string? optional = key;
        return required.Length + optional?.Length ?? 0;
    }
}`)
        Assert.Contains("item!!.Name", printed, StringComparison.Ordinal)
        Assert.Contains("item!!.Next!!.Name", printed, StringComparison.Ordinal)
        Assert.Contains("Extensions.Label(item!!)", printed, StringComparison.Ordinal)
        Assert.Contains("items!!.Count()", printed, StringComparison.Ordinal)
        Assert.Contains("for current in items!!", printed, StringComparison.Ordinal)
        Assert.Contains("var required = key!!", printed, StringComparison.Ordinal)
        Assert.Contains("required = key!!", printed, StringComparison.Ordinal)
        Assert.Contains("Required = key!!", printed, StringComparison.Ordinal)
        Assert.Contains("Consume(key!!)", printed, StringComparison.Ordinal)
        Assert.Contains("$$map[key!!]", printed, StringComparison.Ordinal)
        Assert.Contains("let optional string? = key", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("optional string? = key!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func DirectAndAttributedGuards_KeepNullableValuesUsable() {
        let printed = Translate(`#nullable enable
using System.Diagnostics.CodeAnalysis;

namespace Demo;

public static class Repro
{
    private static bool Present([NotNullWhen(true)] string? value) =>
        value is not null;

    private static int Length(string value) => value.Length;

    public static int Direct(string? value)
    {
        if (value is null)
            return 0;
        return Length(value);
    }

    public static int Attributed(string? value)
    {
        if (!Present(value))
            return 0;
        return Length(value);
    }
}`)
        Assert.Contains("Length(value!!)", printed, StringComparison.Ordinal)
        Assert.Contains("@NotNullWhen(true)", printed, StringComparison.Ordinal)
    }

    @Fact
    func ImportedGenericTupleReturn_AssertsReferenceElementAtInvocation() {
        let printed = Translate(`using System;
using System.Linq;

public static class Repro
{
    public static int Run()
    {
        var tools = new (string Name, Func<int> Handler)[]
        {
            ("answer", () => 42),
        };
        var tool = tools.FirstOrDefault(item => item.Name == "answer");
        if (tool.Name is null)
            return 0;
        return tool.Handler();
    }
}`)
        // ADR-0172: the named element access stays by-name.
        Assert.Contains("tool.Handler!!()", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(result!!.Success, string.Join(Environment.NewLine, result!!.Errors) + "\n" + printed)
            return printed
        }
    }
}
