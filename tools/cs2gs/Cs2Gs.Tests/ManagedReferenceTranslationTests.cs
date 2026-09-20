// <copyright file="ManagedReferenceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class ManagedReferenceTranslationTests
{
    [Theory]
    [InlineData("int managed = 1;", "managed", 4)]
    [InlineData("int managed() => 2;", "managed()", 5)]
    public void AllSymbolCollisionsQualifyRuntimeSpelling(string declaration, string value, int expected)
    {
        var source = $$"""
            using Gsharp.Values;
            namespace ManagedTranslation;
            public class Probe {
                public static int Run() {
                    {{declaration}}
                    int[] values = { 3 };
                    var p = ManagedRef<int>.FromArray(values, 0);
                    return p.Borrow() + {{value}};
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Managed.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Gsharp.Values.ManagedRef[int32].FromArray", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }
}
