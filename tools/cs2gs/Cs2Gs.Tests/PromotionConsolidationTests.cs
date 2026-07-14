// <copyright file="PromotionConsolidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public class PromotionConsolidationTests
{
    [Fact]
    public void ObliviousClassConstrainedValuePromotesSymmetricallyAcrossSinks()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder<T> where T : class
    {
        public T Item;
    }

    public class C<T> where T : class
    {
        public T Field;
        public T Property { get; set; }

        public void Accept(T item) { }

        public void Assign(T value)
        {
            if (value == null) { return; }
            Field = value;
            Property = value;
            T local = value;
            Accept(value);
        }

        public T Return(T value)
        {
            if (value == null) { return default(T); }
            return value;
        }

        public (T, T) Pair(T value)
        {
            if (value == null) { return (default(T), default(T)); }
            return (value, value);
        }

        public Holder<T> ObjectInit(T value)
        {
            if (value == null) { return new Holder<T>(); }
            return new Holder<T> { Item = value };
        }

        public T SwitchArm(T value, bool pick)
        {
            if (value == null) { return default(T); }
            return pick switch
            {
                true => value,
                _ => default(T),
            };
        }
    }
}");

        Assert.Contains("Item T?", printed);
        Assert.Contains("Field T?", printed);
        Assert.Contains("Property T?", printed);
        Assert.Contains("Assign(value T?)", printed);
        Assert.Contains("local T?", printed);
        Assert.Contains("Accept(item T?)", printed);
        Assert.Contains("Return(value T?) T?", printed);
        Assert.Contains("Pair(value T?) (T?, T?)", printed);
        Assert.Contains("ObjectInit(value T?) Holder[T]", printed);
        Assert.Contains("SwitchArm(value T?, pick bool) T?", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
