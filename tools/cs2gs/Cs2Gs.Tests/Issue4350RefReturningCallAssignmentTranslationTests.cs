// <copyright file="Issue4350RefReturningCallAssignmentTranslationTests.cs" company="GSharp">
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

/// <summary>Issue #4350: preserve direct writes through ref-returning calls.</summary>
public sealed class Issue4350RefReturningCallAssignmentTranslationTests
{
    [Fact]
    public void ManagedReferenceBorrow_AssignmentAndIncrementRemainDirect()
    {
        const string source = """
            using Gsharp.Values;
            namespace RefCallTranslation;
            public class Probe
            {
                public static int Run()
                {
                    var values = new[] { 10 };
                    var handle = ManagedRef<int>.FromArray(values, 0);
                    handle.Borrow() = 17;
                    handle.Borrow()++;
                    return values[0];
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Empty(context.Diagnostics);
        Assert.Contains("handle.Borrow() = 17", printed, StringComparison.Ordinal);
        Assert.Contains("handle.Borrow()++", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);

        var result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Probe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(18, result.Value);
    }
}
