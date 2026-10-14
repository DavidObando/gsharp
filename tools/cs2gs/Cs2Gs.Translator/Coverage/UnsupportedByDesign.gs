// <copyright file="UnsupportedByDesign.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Coverage

import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic

/// The single registry of C# constructs the translator rejects
/// <em>deliberately</em> (ADR-0138). (cref:TranslationContext.ReportUnsupported)
/// consults it at every whole-construct rejection: a registered kind is a
/// recorded design decision (triage id `CS2GS-UNSUPPORTED`); an
/// unregistered kind is an accidental fallthrough (triage id `CS2GS-GAP`)
/// that TranslatorExhaustivenessTests force to be classified. The registry is
/// kept in lockstep with the UnsupportedByDesign rows of the construct
/// inventory by the same tests.
shared class UnsupportedByDesign {
    private let Registry IReadOnlyDictionary[SyntaxKind, UnsupportedRationale] = Build()

    /// Looks up the deliberate-rejection rationale for a syntax kind.
    /// @param kind The C# syntax kind.
    /// @param rationale The recorded rationale when registered.
    /// @returns `true` when the kind is a recorded design decision.
    func TryGetRationale(kind SyntaxKind, out rationale UnsupportedRationale) bool -> Registry.TryGetValue(
        kind,
        out rationale
    )

    /// Gets a snapshot of the registry for the inventory-consistency test.
    /// @returns The registered kinds and their rationales.
    func Snapshot() IReadOnlyDictionary[SyntaxKind, UnsupportedRationale] -> Registry

    /// Builds the registry from the same structural rules that seeded the
    /// construct inventory, plus the explicit legacy/preview entries. Keeping
    /// the rules programmatic means a Roslyn bump that adds e.g. a new
    /// directive kind lands here and in the inventory identically.
    /// @returns The registry.
    private func Build() IReadOnlyDictionary[SyntaxKind, UnsupportedRationale] {
        let registry = Dictionary[SyntaxKind, UnsupportedRationale]()
        let surface = HashSet[string](RoslynSurface.NodeKindNames(), StringComparer.Ordinal)
        for kind in Enum.GetValues[SyntaxKind]() {
            let name = kind.ToString()
            if !surface.Contains(name) {
                continue
            }
            if name.EndsWith("DirectiveTrivia", StringComparison.Ordinal) || kind == SyntaxKind.LineDirectivePosition {
                registry[kind] = UnsupportedRationale.Preprocessor
                continue
            }
            // By name: UnionDeclaration and WithElement are [Experimental]/
            // preview-only in Roslyn 5.6 (naming the enum member trips
            // RSEXPERIMENTAL006; `with(...)` collection elements are CS8652
            // under LangVersion latest), and the others are parser
            // error-recovery artifacts rather than translatable constructs.
            if name == "UnionDeclaration" ||
                name == "UnknownAccessorDeclaration" ||
                name == "WithElement" ||
                name == "IncompleteMember" {
                registry[kind] = UnsupportedRationale.NotReachable
                continue
            }
            let isDocStructure = name.StartsWith("Xml", StringComparison.Ordinal) || name.Contains(
                "Cref",
                StringComparison.Ordinal
            ) ||
                kind == SyntaxKind.SingleLineDocumentationCommentTrivia ||
                kind == SyntaxKind.MultiLineDocumentationCommentTrivia ||
                kind == SyntaxKind.SkippedTokensTrivia
            if isDocStructure {
                registry[kind] = UnsupportedRationale.ToolingScope
            }
        }
        registry[SyntaxKind.MakeRefExpression] = UnsupportedRationale.NoGsharpConstruct
        registry[SyntaxKind.RefTypeExpression] = UnsupportedRationale.NoGsharpConstruct
        registry[SyntaxKind.RefValueExpression] = UnsupportedRationale.NoGsharpConstruct
        registry[SyntaxKind.ArgListExpression] = UnsupportedRationale.NoGsharpConstruct
        // Extern aliases disambiguate identically-named assemblies — a
        // project-system feature G# does not model and no mapping is planned.
        registry[SyntaxKind.ExternAliasDirective] = UnsupportedRationale.NoGsharpConstruct
        return registry
    }
}
