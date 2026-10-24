// <copyright file="BoundSemantics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Linq
import System.Reflection

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
        let model = GetModel(compilation, token)
        if model == nil || token == nil {
            return nil
        }
        return model.GetSymbolInfo(token).Symbol
    }

    /// Gets the CLR member the binder bound [`token`](paramref) to when the
    /// token names an imported method or property.
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token naming a member or a call.
    /// @returns The bound member, or null when the token does not name an imported member.
    func GetImportedMember(compilation Compilation?, token SyntaxToken?) MemberInfo? {
        let model = GetModel(compilation, token)
        if model == nil || token == nil {
            return nil
        }
        let member MemberInfo? = switch model.GetReferencedExpression(token) {
            case instanceCall is BoundImportedInstanceCallExpression: instanceCall.Method
            case staticCall is BoundImportedCallExpression: staticCall.Function?.Method
            case constrained is BoundConstrainedStaticCallExpression: constrained.ClrMethod
            case property is BoundClrPropertyAccessExpression: property.Member
            default: default(MemberInfo?)
        }
        return if member != nil && member.Name == token.Text {
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

    /// Gets the semantic model of [`token`](paramref)'s tree when that tree
    /// belongs to [`compilation`](paramref).
    private func GetModel(compilation Compilation?, token SyntaxToken?) GSharp.Core.CodeAnalysis.SemanticModel? {
        if compilation == nil || token == nil || token.Kind != SyntaxKind.IdentifierToken || token.IsMissing {
            return nil
        }
        return GetModel(compilation, token.SyntaxTree)
    }

    private func GetModel(compilation Compilation, tree SyntaxTree?) GSharp.Core.CodeAnalysis.SemanticModel? {
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
