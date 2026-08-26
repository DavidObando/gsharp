// <copyright file="Issue3564TupleKeyIndexBridgingTests.cs" company="GSharp">
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

/// <summary>
/// Issue #3564: a tuple-typed index key whose G#-side elements are
/// promoted-nullable while the indexer's key tuple elements are not
/// (`store[key]` where `key` is `(ISymbol?, SyntaxNode)` against a
/// `Dictionary[(ISymbol, SyntaxNode), bool]` field) cannot be bridged with a
/// whole-value `!!` — G# has no implicit `(T?, U) → (T, U)`. The index
/// argument now rebuilds per element, asserting only the promoted slots:
/// `store[(key.Item1!!, key.Item2)]`.
/// </summary>
public class Issue3564TupleKeyIndexBridgingTests
{
    [Fact]
    public void PromotedTupleKey_RebuildsPerElementAtIndexer()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
        public string Label { get; set; } = """";
    }

    public class Cache
    {
        private readonly Dictionary<(string, Node), bool> store = new();

        private static string Resolve(Node node) => null;

        public bool Lookup(Node scope)
        {
            var name = Resolve(scope);
            var key = (name, scope);
            if (this.store.TryGetValue(key, out var cached))
            {
                return cached;
            }

            this.store[key] = true;
            return this.store[key];
        }
    }
}");

        Assert.Contains("this.store[(key.Item1!!, key.Item2)] = true", printed);
        Assert.Contains("return this.store[(key.Item1!!, key.Item2)]", printed);
    }

    [Fact]
    public void UnpromotedTupleKey_StaysBare()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
        public string Label { get; set; } = """";
    }

    public class Cache
    {
        private readonly Dictionary<(string, Node), bool> store = new();

        public bool Lookup(Node scope)
        {
            var key = (scope.Label, scope);
            this.store[key] = true;
            return this.store[key];
        }
    }
}");

        Assert.Contains("this.store[key] = true", printed);
        Assert.DoesNotContain("key.Item1!!", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
