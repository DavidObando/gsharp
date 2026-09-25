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
    /// The path of the stub tree in the back-translation compilation. The
    /// translator tells the stub from generator output by path (a generated
    /// implementation whose definition is NOT in a translated file becomes a
    /// G# implementing part), so this path must be one no generator can emit:
    /// Roslyn rejects a hint name containing <c>&lt;</c> or <c>&gt;</c>
    /// (<c>AddSource</c> throws), so no generated tree can share it.
    /// </summary>
    public const string StubPath = "<gsgen-stub>.cs";

    /// <summary>
    /// Back-translates the generated C# documents into G# partial parts.
    /// </summary>
    /// <param name="stubCSharp">The declaration-only C# stub the generators ran against.</param>
    /// <param name="generated">The generated C# documents.</param>
    /// <param name="references">The metadata references used to bind stub + generated code.</param>
    /// <param name="declaringParts">
    /// The lone G# declaring parts the stub rendered as C# partial method
    /// definitions, whose headers the generated implementing parts are spelled
    /// with (<see cref="ImplementingPartHeaders"/>); <see langword="null"/> or
    /// empty to keep every header as back-translated.
    /// </param>
    /// <returns>The back-translated G# parts: one per namespace of each generated document with members or file-level attributes.</returns>
    public static IReadOnlyList<TranslatedGsDocument> Translate(
        string stubCSharp,
        IReadOnlyList<GeneratedCsDocument> generated,
        IReadOnlyList<MetadataReference> references,
        IReadOnlyList<StubPartialDefinition> declaringParts = null)
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
        SyntaxTree stubTree = CSharpSyntaxTree.ParseText(stubCSharp, parseOptions, path: StubPath);

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

        // Every generated tree is translated; the stub never is. A generated
        // partial method implementation whose definition is in the stub (a
        // user G# declaring part, e.g. `@GeneratedRegex ... partial func`)
        // therefore becomes a G# implementing part (ADR-0192 follow-on 2).
        var translatedFilePaths = generatedTrees.Select(t => t.Tree.FilePath).ToList();

        foreach ((GeneratedCsDocument doc, SyntaxTree tree) in generatedTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            var loaded = new LoadedDocument(doc.HintName, tree, model);

            // ADR-0192 follow-on 2, step 4: one G# unit per C# namespace the
            // document declares, exactly as `cs2gs migrate`'s repository
            // layout splits a multi-namespace file (TranslateStage). A single
            // unit would hoist every declaration into the first namespace: the
            // Regex generator's one file declares the user's `partial class P`
            // in the user's namespace AND its helper types (`Digits_0`,
            // `Utilities`, `RunnerFactory`, the `IndexOfAny*` extension funcs)
            // in `System.Text.RegularExpressions.Generated`, so collapsing the
            // two put the helpers in the user's package, where a user type
            // named `Utilities` collided with them (GS0102). Split, the helpers
            // keep their own package and the user-package unit reaches them
            // through an ordinary import. The generator declares those helpers
            // `file` classes; G# has no file scope, so they surface as
            // `internal` types of that distinct package: invisible outside the
            // assembly, and out of the user's package namespace. Several user
            // packages that each use the generator still get ONE helper
            // package, because the generator emits one file with one
            // `Generated` namespace.
            IReadOnlyList<string> packages = CSharpToGSharpTranslator.GetDeclaredPackages(loaded)
                .OrderBy(package => package.Count(c => c == '.'))
                .ToList();
            int unitCount = Math.Max(1, packages.Count);
            for (int unitIndex = 0; unitIndex < unitCount; unitIndex++)
            {
                string package = packages.Count > 1 ? packages[unitIndex] : null;
                CompilationUnit unit = new CSharpToGSharpTranslator(
                    preservePartialParts: true,
                    packageFilter: package,
                    includeFileAttributes: unitIndex == 0,
                    widenObliviousReferenceFields: true,
                    translatedFilePaths: translatedFilePaths,
                    emitGeneratedImplementingParts: true)
                    .TranslateDocument(loaded);

                // Skip a unit that carried no translatable content.
                if (unit.Members.Count == 0 && unit.FileAttributes.Count == 0)
                {
                    continue;
                }

                var hostDiagnostics = new List<GeneratorHostDiagnostic>();
                string gs = ImplementingPartHeaders.Apply(
                    unit,
                    GSharpPrinter.Print(unit),
                    declaringParts ?? Array.Empty<StubPartialDefinition>(),
                    hostDiagnostics);

                RoundTripResult roundTrip = GSharpRoundTrip.Validate(gs);
                string hintName = unitIndex == 0 ? doc.HintName : SplitHintName(doc.HintName, package);
                results.Add(new TranslatedGsDocument(hintName, gs, roundTrip.Errors, hostDiagnostics));
            }
        }

        return results;
    }

    /// <summary>
    /// The hint name of a secondary namespace unit split out of a generated
    /// document: the document's own hint name with the package, dots turned
    /// into underscores, before its extension (<c>RegexGenerator.g.cs</c> in
    /// <c>System.Text.RegularExpressions.Generated</c> becomes
    /// <c>RegexGenerator.System_Text_RegularExpressions_Generated.g.cs</c>),
    /// so every unit is written to its own deterministic <c>.g.gs</c> file.
    /// </summary>
    private static string SplitHintName(string hintName, string package)
    {
        string suffix = package.Replace('.', '_');
        foreach (string extension in new[] { ".g.cs", ".cs" })
        {
            if (hintName.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            {
                return hintName.Substring(0, hintName.Length - extension.Length) + "." + suffix + extension;
            }
        }

        return hintName + "." + suffix;
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
    /// <param name="hostDiagnostics">Diagnostics the host reported while producing the part, or <see langword="null"/> for none.</param>
    public TranslatedGsDocument(
        string hintName,
        string gSharpSource,
        IReadOnlyList<string> roundTripErrors,
        IReadOnlyList<GeneratorHostDiagnostic> hostDiagnostics = null)
    {
        HintName = hintName;
        GSharpSource = gSharpSource;
        RoundTripErrors = roundTripErrors ?? Array.Empty<string>();
        HostDiagnostics = hostDiagnostics ?? Array.Empty<GeneratorHostDiagnostic>();
    }

    /// <summary>Gets the originating generator hint name.</summary>
    public string HintName { get; }

    /// <summary>Gets the back-translated G# source.</summary>
    public string GSharpSource { get; }

    /// <summary>Gets the G# round-trip parse errors (empty when valid).</summary>
    public IReadOnlyList<string> RoundTripErrors { get; }

    /// <summary>Gets the diagnostics the host reported while producing the part (e.g. <c>GS9208</c>).</summary>
    public IReadOnlyList<GeneratorHostDiagnostic> HostDiagnostics { get; }
}
