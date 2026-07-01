// <copyright file="Issue1567CollectionInitializerObjectInitTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #1567 — a C# collection initializer
/// nested inside an object initializer, e.g. <c>new T { Prop = { a, b } }</c>,
/// which populates a GET-ONLY collection property by lowering to
/// <c>receiver.Prop.Add(a); receiver.Prop.Add(b);</c> rather than assigning.
/// <para>
/// cs2gs must emit the target-less braced member form
/// <c>T{ Prop: { a, b } }</c> (a <see cref="CollectionInitializerExpression"/>
/// with a null Target) so gsc lowers to Add calls on the get-only property
/// instead of reporting GS0127. The previously-emitted array-literal form
/// (<c>Prop: []object{...}</c>) both hit GS0127 and dropped dictionary keys.
/// </para>
/// </summary>
public class Issue1567CollectionInitializerObjectInitTranslationTests
{
    [Fact]
    public void GetOnlyCollectionProperty_EmitsBracedMemberInitializer()
    {
        string printed = TranslateUnit(@"
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
}");

        // Braced member form, not an array-literal assignment.
        Assert.Contains("Converters: {", printed);
        Assert.DoesNotContain("Converters: []", printed);

        // The settable scalar member keeps a normal assignment form.
        Assert.Contains("WriteIndented: true", printed);
    }

    [Fact]
    public void ProcessStartInfoArgumentList_EmitsBracedMemberInitializer()
    {
        string printed = TranslateUnit(@"
using System.Diagnostics;

namespace Demo
{
    public class C
    {
        public ProcessStartInfo Make(string path) => new ProcessStartInfo
        {
            FileName = ""explorer.exe"",
            ArgumentList = { path },
        };
    }
}");

        Assert.Contains("ArgumentList: {", printed);
        Assert.DoesNotContain("ArgumentList: []", printed);
        Assert.Contains("FileName: ", printed);
    }

    [Fact]
    public void GetOnlyDictionaryProperty_PreservesKeysInBracedForm()
    {
        // A dictionary collection-initializer inside an object initializer must
        // keep its keys — the old array-literal path dropped them.
        string printed = TranslateUnit(@"
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
            Map = { [""a""] = 1, [""b""] = 2 },
        };
    }
}");

        Assert.Contains("Map: {", printed);
        Assert.DoesNotContain("Map: []", printed);
        Assert.Contains("\"a\"", printed);
        Assert.Contains("\"b\"", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
