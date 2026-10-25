// <copyright file="BoundSemantics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices

/// Issue #4989: the language server's one read of what the binder decided.
/// Hover, completion, signature help, navigation and semantic tokens ask this
/// accessor for the symbol a token refers to and for the type an expression
/// has, so they all report the bound tree rather than a type or member they
/// recompute from syntax.
/// @remarks Each query forwards to the compilation's ADR-0169
/// (cref:GSharp.Core.CodeAnalysis.SemanticModel), which owns the receiver-chain
/// interpretation (ADR-0212 slice S2). Each query returns `null` when the binder
/// left no answer (unbound or erroneous code, a token from a stale tree);
/// callers then fall back to their syntactic lookup.
shared class BoundSemantics {
    /// Gets the symbol the binder declared at, or resolved, [`token`](paramref).
    /// Imported CLR members are not reported here; see (cref:GetImportedMember).
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token.
    /// @returns The symbol, or null when the binder has no answer for the token.
    func GetSymbol(compilation Compilation?, token SyntaxToken?) Symbol? {
        let bound = Bind(compilation, token, matchStaleTree: false)
        if bound == nil {
            return nil
        }
        return bound.Model.GetSymbolInfo(bound.Token).Symbol
    }

    /// Gets the symbol a simple name resolves to at [`token`](paramref)'s position, by the scope
    /// rules of the semantic model (ADR-0212 slice S3): the innermost local, then the members of
    /// the enclosing type, then the compilation's globals.
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token naming a variable, a function or a type.
    /// @returns The symbol, or null when the name resolves to nothing there.
    func LookupName(compilation Compilation?, token SyntaxToken?) Symbol? {
        let bound = Bind(compilation, token)
        if bound == nil {
            return nil
        }
        // The token may declare a symbol that is not yet visible at its own position (a stale local).
        let declared = bound.Model.GetSymbolInfo(bound.Token).Symbol
        if declared != nil {
            return declared
        }
        let symbols = bound.Model.LookupSymbols(bound.Token.Span.Start, bound.Token.ValueText)
        return if symbols.IsDefaultOrEmpty {
            default(Symbol?)
        } else {
            symbols[0]
        }
    }

    /// Gets the CLR member the binder bound [`token`](paramref) to when the
    /// token names an imported method or property.
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token naming a member or a call.
    /// @returns The bound member, or null when the token does not name an imported member.
    func GetImportedMember(compilation Compilation?, token SyntaxToken?) MemberInfo? {
        let bound = Bind(compilation, token, matchStaleTree: false)
        if bound == nil {
            return nil
        }
        let member MemberInfo? = switch bound.Model.GetReferencedExpression(bound.Token) {
            case instanceCall is BoundImportedInstanceCallExpression: instanceCall.Method
            case staticCall is BoundImportedCallExpression: staticCall.Function?.Method
            case constrained is BoundConstrainedStaticCallExpression: constrained.ClrMethod
            case property is BoundClrPropertyAccessExpression: property.Member
            default: default(MemberInfo?)
        }
        return if member != nil && member.Name == bound.Token.Text {
            member
        } else {
            default(MemberInfo?)
        }
    }

    /// Gets the type the binder gave [`expression`](paramref), including any
    /// flow narrowing in effect where it is read.
    /// @param compilation The compilation the expression's tree belongs to.
    /// @param expression An expression, typically the receiver of a member access.
    /// @returns The bound type, or null when the binder has no answer for the expression.
    func GetExpressionType(compilation Compilation?, expression ExpressionSyntax?) TypeSymbol? {
        if expression == nil || compilation == nil {
            return nil
        }
        let model = GetModel(compilation, expression.SyntaxTree)
        if model == nil {
            return nil
        }
        return model.GetReceiverTypeInfo(expression).Type
    }

    /// Gets the semantic model that answers for [`token`](paramref), and the token in that model's
    /// tree. A token of a stale parse of a file (a cached document that the project has since
    /// reparsed) is answered by the compilation's tree of the same file when the text is the same, for
    /// the scope queries only; the bound-node queries answer the compilation's own tree instances.
    private func Bind(compilation Compilation?, token SyntaxToken?, matchStaleTree bool = true)(
        Model GSharp.Core.CodeAnalysis.SemanticModel,
        Token SyntaxToken
    )? {
        if compilation == nil || token == nil || token.Kind != SyntaxKind.IdentifierToken || token.IsMissing {
            return nil
        }
        let tree = if matchStaleTree {
            MatchingTree(compilation, token.SyntaxTree)
        } else if compilation.SyntaxTrees.Contains(token.SyntaxTree) {
            token.SyntaxTree
        } else {
            default(SyntaxTree?)
        }
        if tree == nil {
            return nil
        }
        let model = GetModel(compilation, tree)
        if model == nil {
            return nil
        }
        if object.ReferenceEquals(tree, token.SyntaxTree) {
            return (model, token)
        }
        let mapped = SemanticLookup.FindTokenAt(tree, token.Span.Start)
        if mapped == nil || mapped.Kind != token.Kind || mapped.Span.Length != token.Span.Length || !string.Equals(
            mapped.Text,
            token.Text,
            StringComparison.Ordinal
        ) {
            return nil
        }
        return (model, mapped)
    }

    /// Gets the semantic model for positions of [`tree`](paramref): the model of the compilation's
    /// tree of the same file with the same text, so an offset in the one is an offset in the other.
    /// @param compilation The compilation to query.
    /// @param tree A tree of the file, possibly a stale parse of it.
    /// @returns The model, or null when the compilation holds no tree with that file and text.
    func GetPositionModel(compilation Compilation, tree SyntaxTree?) GSharp.Core.CodeAnalysis.SemanticModel? {
        if tree == nil {
            return nil
        }
        let matching = MatchingTree(compilation, tree)
        if matching == nil {
            return nil
        }
        return GetModel(compilation, matching)
    }

    private data class StaleMatch(Compilation WeakReference[Compilation], Tree SyntaxTree?) : IEquatable[StaleMatch] { }

    private func MatchingTree(compilation Compilation, tree SyntaxTree) SyntaxTree? {
        if compilation.SyntaxTrees.Contains(tree) {
            return tree
        }
        if StaleMatches.TryGetValue(tree, out var cached) && cached.Compilation.TryGetTarget(out var cachedFor) &&
            object.ReferenceEquals(cachedFor, compilation) {
            return cached.Tree
        }
        var found SyntaxTree? = nil
        let fileName = tree.Text?.FileName
        if !string.IsNullOrEmpty(fileName) {
            for candidate in compilation.SyntaxTrees {
                if SourcePathIdentity.AreSame(candidate.Text?.FileName, fileName) &&
                    candidate
                    .Text
                    .Length == tree
                    .Text
                    .Length &&
                    string.Equals(candidate.Text.ToString(), tree.Text.ToString(), StringComparison.Ordinal) {
                    found = candidate
                    break
                }
            }
        }
        StaleMatches.AddOrUpdate(tree, StaleMatch(WeakReference[Compilation](compilation), found))
        return found
    }

    // Stale tree to the compilation's tree of the same text, found once per compilation.
    private let StaleMatches ConditionalWeakTable[SyntaxTree, StaleMatch] = ConditionalWeakTable[
        SyntaxTree,
        StaleMatch
    ]()

    func GetModel(compilation Compilation, tree SyntaxTree?) GSharp.Core.CodeAnalysis.SemanticModel? {
        if tree == nil {
            return nil
        }
        // Only the compilation's own tree instance is answered. A token from a
        // stale parse of the file keeps the callers' syntactic fallbacks until the
        // document is refreshed; mapping it here would cost a text comparison
        // and a token search per query.
        if !compilation.SyntaxTrees.Contains(tree) {
            return nil
        }
        try {
            // The model indexes the bound program lazily; binding it here keeps a
            // compilation that cannot be bound on the caller's fallback path
            // instead of throwing from the first query.
            let _ = compilation.BoundProgram
            return compilation.GetSemanticModel(tree)
        } catch (InvalidOperationException) {
            return nil
        }
    }
}
