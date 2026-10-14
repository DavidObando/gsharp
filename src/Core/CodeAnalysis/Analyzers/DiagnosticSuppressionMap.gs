// <copyright file="DiagnosticSuppressionMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable

/// ADR-0175 (issues #3820 / #3824): the source-level, scoped analyzer
/// suppressions declared by `@SuppressDiagnostic("ID", …)` annotations in
/// a compilation's syntax trees.
///
/// A suppression's scope is the span of the syntactic construct it annotates —
/// a declaration for the attribute form, the `{`..`}` of the block
/// form. A diagnostic is suppressed when its primary location falls inside a
/// scope naming its ID; the same diagnostic reported anywhere else in the same
/// file still surfaces.
class DiagnosticSuppressionMap {
    private let scopes ImmutableArray[DiagnosticSuppressionMap.Scope]

    private init(scopes ImmutableArray[DiagnosticSuppressionMap.Scope]) {
        this.scopes = scopes
    }

    /// Gets a value indicating whether [`diagnostic`](paramref) is
    /// suppressed by a source annotation.
    /// @param diagnostic The diagnostic to test.
    /// @returns `true` when a scope covering the diagnostic names its ID.
    func IsSuppressed(diagnostic Diagnostic) bool {
        if this.scopes.IsDefaultOrEmpty {
            return false
        }
        // `TextLocation.Text` is genuinely nullable — the driver reports its own
        // GS9304 with a `default` location — and a null one matches no scope.
        let location = diagnostic.Location
        if location.Text == nil {
            return false
        }
        for scope_ in this.scopes {
            if !object.ReferenceEquals(scope_.Text, location.Text) {
                continue
            }
            if location.Span.Start < scope_.Span.Start || location.Span.Start >= scope_.Span.End {
                continue
            }
            for id in scope_.Ids {
                if string.Equals(id, diagnostic.Id, StringComparison.OrdinalIgnoreCase) {
                    return true
                }
            }
        }
        return false
    }

    /// ADR-0175 amendment (issue #4422): drops the compiler's own (`GS####`)
    /// diagnostics that a source `@SuppressDiagnostic` scope covers.
    /// Only a diagnostic whose severity is below
    /// (cref:DiagnosticSeverity.Error) can be suppressed: like C#'s
    /// `#pragma warning disable`, a scope cannot hide a compiler error.
    /// The severity tested is the descriptor's, before any
    /// `/gsdiag`/`/warnaserror` promotion, so a suppressed warning
    /// stays suppressed under warnings-as-errors.
    /// @param diagnostics The compiler diagnostics.
    /// @returns The diagnostics no scope suppresses (the same array when none is).
    func FilterCompilerDiagnostics(diagnostics ImmutableArray[Diagnostic]) ImmutableArray[Diagnostic] {
        if this.scopes.IsDefaultOrEmpty || diagnostics.IsDefaultOrEmpty {
            return diagnostics
        }
        var kept ImmutableArray[Diagnostic].Builder? = nil
        for var i = 0; i < diagnostics.Length; i++ {
            let diagnostic = diagnostics[i]
            let suppressed = !diagnostic.IsError && IsSuppressed(diagnostic)
            if suppressed && kept == nil {
                kept = ImmutableArray.CreateBuilder[Diagnostic](diagnostics.Length)
                for var j = 0; j < i; j++ {
                    kept.Add(diagnostics[j])
                }
            }
            if !suppressed {
                kept?.Add(diagnostic)
            }
        }
        return if kept == nil {
            diagnostics
        } else {
            kept.ToImmutable()
        }
    }

    private struct Scope {
        internal init(text SourceText, span TextSpan, ids ImmutableArray[string]) {
            Text = text
            Span = span
            Ids = ids
        }

        internal prop Text SourceText {
            get;
        }

        internal prop Span TextSpan {
            get;
        }

        internal prop Ids ImmutableArray[string] {
            get;
        }
    }

    shared {
        /// An empty map that suppresses nothing.
        let Empty DiagnosticSuppressionMap = DiagnosticSuppressionMap(
            ImmutableArray[DiagnosticSuppressionMap.Scope].Empty
        )

        /// Builds the suppression map for [`syntaxTrees`](paramref).
        /// @param syntaxTrees The trees to scan.
        /// @returns The map; (cref:Empty) when no suppression is declared.
        func Build(syntaxTrees IEnumerable[SyntaxTree]) DiagnosticSuppressionMap {
            let builder = ImmutableArray.CreateBuilder[DiagnosticSuppressionMap.Scope]()
            for tree in syntaxTrees {
                Collect(tree.Root, tree.Text, builder)
            }
            return if builder.Count == 0 {
                Empty
            } else {
                DiagnosticSuppressionMap(builder.ToImmutable())
            }
        }

        /// Gets a value indicating whether [`annotation`](paramref) is the
        /// compiler-intrinsic `@SuppressDiagnostic` annotation (ADR-0175).
        /// Recognition is by source spelling: the annotation has no CLR type, is
        /// never bound, and is never written to metadata, so a compilation needs no
        /// extra assembly reference to use it.
        /// @param annotation The annotation to test.
        /// @returns `true` when the name is `SuppressDiagnostic` or `SuppressDiagnosticAttribute`.
        func IsSuppressDiagnostic(annotation AnnotationSyntax) bool {
            if annotation.HasTypeArgumentList {
                return false
            }
            let name = annotation.GetNameText()
            return string.Equals(name, "SuppressDiagnostic", StringComparison.Ordinal) || string.Equals(
                name,
                "SuppressDiagnosticAttribute",
                StringComparison.Ordinal
            )
        }

        /// Extracts the diagnostic IDs named by a `@SuppressDiagnostic`
        /// annotation. Every positional argument must be a string literal; an
        /// argument that is not contributes no ID (the binder reports GS9305).
        /// @param annotation The annotation to read.
        /// @returns The IDs, in source order.
        func GetSuppressedIds(annotation AnnotationSyntax) ImmutableArray[string] {
            // `Arguments` is a nullable reference on the syntax node: an annotation
            // written without a parenthesised list (`@SuppressDiagnostic`) has none.
            if annotation.Arguments == nil || annotation.Arguments.Count == 0 {
                return ImmutableArray[string].Empty
            }
            let builder = ImmutableArray.CreateBuilder[string]()
            for argument in annotation.Arguments {
                if argument is LiteralExpressionSyntax{Value: string text} && IsWellFormedId(text) {
                    builder.Add(text)
                }
            }
            return builder.ToImmutable()
        }

        /// Gets a value indicating whether [`text`](paramref) has the shape of
        /// a diagnostic ID: at least one ASCII letter followed by at least one
        /// digit (`GS0157`, `GSA0005`, `PROBE001`).
        /// @param text The candidate ID.
        /// @returns `true` when the shape matches.
        func IsWellFormedId(text string?) bool {
            if string.IsNullOrEmpty(text) {
                return false
            }
            var i = 0
            while i < text.Length && char.IsAsciiLetter(text[i]) {
                i++
            }
            if i == 0 || i == text.Length {
                return false
            }
            for var j = i; j < text.Length; j++ {
                if !char.IsAsciiDigit(text[j]) {
                    return false
                }
            }
            return true
        }

        /// Returns the annotations attached to [`node`](paramref), or an empty
        /// array when the node kind carries none. Annotation lists are declared on
        /// unrelated node types rather than a shared base, so this dispatch is the
        /// single place that knows all of them.
        /// @param node The node to inspect.
        /// @returns The node's annotations.
        internal func GetAnnotations(node SyntaxNode) ImmutableArray[AnnotationSyntax] -> switch node {
            case m is MemberSyntax: m.Annotations
            case b is BlockStatementSyntax: b.Annotations
            case v is VariableDeclarationSyntax: v.Annotations
            case f is FieldDeclarationSyntax: f.Annotations
            case p is PropertyDeclarationSyntax: p.Annotations
            case e is EventDeclarationSyntax: e.Annotations
            case en is EnumMemberSyntax: en.Annotations
            case pa is ParameterSyntax: pa.Annotations
            default: ImmutableArray[AnnotationSyntax].Empty
        }

        private func Collect(
            node SyntaxNode,
            text SourceText,
            builder ImmutableArray[DiagnosticSuppressionMap.Scope].Builder
        ) {
            let annotations = GetAnnotations(node)
            if !annotations.IsDefaultOrEmpty {
                let ids = ImmutableArray.CreateBuilder[string]()
                for annotation in annotations {
                    if IsSuppressDiagnostic(annotation) {
                        ids.AddRange(GetSuppressedIds(annotation))
                    }
                }
                if ids.Count > 0 {
                    builder.Add(DiagnosticSuppressionMap.Scope(text, node.Span, ids.ToImmutable()))
                }
            }
            for child in node.GetChildren() {
                Collect(child, text, builder)
            }
        }
    }
}
