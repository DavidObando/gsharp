// <copyright file="UnsupportedByDesign.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Microsoft.CodeAnalysis.CSharp;

namespace Cs2Gs.Translator.Coverage;

/// <summary>
/// The single registry of C# constructs the translator rejects
/// <em>deliberately</em> (ADR-0138). <see cref="TranslationContext.ReportUnsupported"/>
/// consults it at every whole-construct rejection: a registered kind is a
/// recorded design decision (triage id <c>CS2GS-UNSUPPORTED</c>); an
/// unregistered kind is an accidental fallthrough (triage id <c>CS2GS-GAP</c>)
/// that TranslatorExhaustivenessTests force to be classified. The registry is
/// kept in lockstep with the UnsupportedByDesign rows of the construct
/// inventory by the same tests.
/// </summary>
public static class UnsupportedByDesign
{
    private static readonly IReadOnlyDictionary<SyntaxKind, UnsupportedRationale> Registry = Build();

    /// <summary>
    /// Looks up the deliberate-rejection rationale for a syntax kind.
    /// </summary>
    /// <param name="kind">The C# syntax kind.</param>
    /// <param name="rationale">The recorded rationale when registered.</param>
    /// <returns><see langword="true"/> when the kind is a recorded design decision.</returns>
    public static bool TryGetRationale(SyntaxKind kind, out UnsupportedRationale rationale)
        => Registry.TryGetValue(kind, out rationale);

    /// <summary>
    /// Gets a snapshot of the registry for the inventory-consistency test.
    /// </summary>
    /// <returns>The registered kinds and their rationales.</returns>
    public static IReadOnlyDictionary<SyntaxKind, UnsupportedRationale> Snapshot() => Registry;

    /// <summary>
    /// Builds the registry from the same structural rules that seeded the
    /// construct inventory, plus the explicit legacy/preview entries. Keeping
    /// the rules programmatic means a Roslyn bump that adds e.g. a new
    /// directive kind lands here and in the inventory identically.
    /// </summary>
    /// <returns>The registry.</returns>
    private static IReadOnlyDictionary<SyntaxKind, UnsupportedRationale> Build()
    {
        var registry = new Dictionary<SyntaxKind, UnsupportedRationale>();
        var surface = new HashSet<string>(RoslynSurface.NodeKindNames(), StringComparer.Ordinal);

        foreach (SyntaxKind kind in Enum.GetValues<SyntaxKind>())
        {
            string name = kind.ToString();
            if (!surface.Contains(name))
            {
                continue;
            }

            if (name.EndsWith("DirectiveTrivia", StringComparison.Ordinal) || kind == SyntaxKind.LineDirectivePosition)
            {
                registry[kind] = UnsupportedRationale.Preprocessor;
                continue;
            }

            // By name: UnionDeclaration and WithElement are [Experimental]/
            // preview-only in Roslyn 5.6 (naming the enum member trips
            // RSEXPERIMENTAL006; `with(...)` collection elements are CS8652
            // under LangVersion latest), and the others are parser
            // error-recovery artifacts rather than translatable constructs.
            if (name is "UnionDeclaration" or "UnknownAccessorDeclaration" or "WithElement"
                or "IncompleteMember")
            {
                registry[kind] = UnsupportedRationale.NotReachable;
                continue;
            }

            bool isDocStructure = name.StartsWith("Xml", StringComparison.Ordinal)
                || name.Contains("Cref", StringComparison.Ordinal)
                || kind is SyntaxKind.SingleLineDocumentationCommentTrivia
                    or SyntaxKind.MultiLineDocumentationCommentTrivia
                    or SyntaxKind.SkippedTokensTrivia;
            if (isDocStructure)
            {
                registry[kind] = UnsupportedRationale.ToolingScope;
            }
        }

        registry[SyntaxKind.MakeRefExpression] = UnsupportedRationale.NoGsharpConstruct;
        registry[SyntaxKind.RefTypeExpression] = UnsupportedRationale.NoGsharpConstruct;
        registry[SyntaxKind.RefValueExpression] = UnsupportedRationale.NoGsharpConstruct;
        registry[SyntaxKind.ArgListExpression] = UnsupportedRationale.NoGsharpConstruct;

        // Extern aliases disambiguate identically-named assemblies — a
        // project-system feature G# does not model and no mapping is planned.
        registry[SyntaxKind.ExternAliasDirective] = UnsupportedRationale.NoGsharpConstruct;

        return registry;
    }
}
