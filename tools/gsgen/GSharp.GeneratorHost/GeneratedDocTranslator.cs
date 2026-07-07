// <copyright file="GeneratedDocTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §C: back-translates each generator-produced C# document into a
/// standalone G# <c>partial</c> part.
/// <para>
/// The generated C# is bound in a single <see cref="CSharpCompilation"/> that
/// also contains the stub tree, so a generated member's references to
/// user-declared types (and to package runtime types) resolve. Each generated
/// tree is then translated with
/// <see cref="CSharpToGSharpTranslator"/>(<c>preservePartialParts: true</c>) so
/// a generated <c>partial class Foo</c> becomes a standalone G# <c>partial</c>
/// part that augments the user's own type rather than being merged.
/// </para>
/// </summary>
public static class GeneratedDocTranslator
{
    /// <summary>
    /// Back-translates the generated C# documents into G# partial parts.
    /// </summary>
    /// <param name="stubCSharp">The declaration-only C# stub the generators ran against.</param>
    /// <param name="generated">The generated C# documents.</param>
    /// <param name="references">The metadata references used to bind stub + generated code.</param>
    /// <returns>The back-translated G# parts, one per non-empty generated document.</returns>
    public static IReadOnlyList<TranslatedGsDocument> Translate(
        string stubCSharp,
        IReadOnlyList<GeneratedCsDocument> generated,
        IReadOnlyList<MetadataReference> references)
    {
        ArgumentNullException.ThrowIfNull(stubCSharp);
        ArgumentNullException.ThrowIfNull(generated);
        ArgumentNullException.ThrowIfNull(references);

        var results = new List<TranslatedGsDocument>();
        if (generated.Count == 0)
        {
            return results;
        }

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree stubTree = CSharpSyntaxTree.ParseText(stubCSharp, parseOptions, path: "GsgenStubs.cs");

        // Bind stub + every generated tree together so generated members resolve
        // against user declarations and package runtime types.
        var generatedTrees = new List<(GeneratedCsDocument Doc, SyntaxTree Tree)>();
        foreach (GeneratedCsDocument doc in generated)
        {
            SyntaxTree tree = CSharpSyntaxTree.ParseText(doc.SourceText, parseOptions, path: doc.HintName);
            generatedTrees.Add((doc, tree));
        }

        var trees = new List<SyntaxTree> { stubTree };
        trees.AddRange(generatedTrees.Select(t => t.Tree));

        var compilation = CSharpCompilation.Create(
            "GsgenBackTranslate",
            trees,
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        foreach ((GeneratedCsDocument doc, SyntaxTree tree) in generatedTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            var loaded = new LoadedDocument(doc.HintName, tree, model);

            CompilationUnit unit = new CSharpToGSharpTranslator(preservePartialParts: true)
                .TranslateDocument(loaded);

            // Skip a generated document that carried no translatable members.
            if (unit.Members.Count == 0)
            {
                continue;
            }

            string gs = GSharpPrinter.Print(unit);

            RoundTripResult roundTrip = GSharpRoundTrip.Validate(gs);
            results.Add(new TranslatedGsDocument(doc.HintName, gs, roundTrip.Errors));
        }

        return results;
    }
}

/// <summary>
/// One back-translated G# part: its originating hint name, the G# source, and
/// any G# round-trip parse errors recorded while validating it (ADR-0145 §C).
/// </summary>
public sealed class TranslatedGsDocument
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TranslatedGsDocument"/> class.
    /// </summary>
    /// <param name="hintName">The originating generator hint name.</param>
    /// <param name="gSharpSource">The back-translated G# source.</param>
    /// <param name="roundTripErrors">Round-trip parse errors, empty when the G# is valid.</param>
    public TranslatedGsDocument(string hintName, string gSharpSource, IReadOnlyList<string> roundTripErrors)
    {
        HintName = hintName;
        GSharpSource = gSharpSource;
        RoundTripErrors = roundTripErrors ?? Array.Empty<string>();
    }

    /// <summary>Gets the originating generator hint name.</summary>
    public string HintName { get; }

    /// <summary>Gets the back-translated G# source.</summary>
    public string GSharpSource { get; }

    /// <summary>Gets the G# round-trip parse errors (empty when valid).</summary>
    public IReadOnlyList<string> RoundTripErrors { get; }
}
