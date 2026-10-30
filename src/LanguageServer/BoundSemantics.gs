// <copyright file="BoundSemantics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
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
    /// Imported CLR members are not reported here; see (cref:GetImportedSymbol).
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token.
    /// @returns The symbol, or null when the binder has no answer for the token.
    func GetSymbol(compilation Compilation?, token SyntaxToken?) Symbol? {
        let bound = Bind(compilation, token, matchStaleTree: false)
        if bound == nil {
            return nil
        }
        let symbol = bound.Model.GetSymbolInfo(bound.Token).Symbol
        return if IsImportedMember(symbol) {
            default(Symbol?)
        } else {
            symbol
        }
    }

    /// Gets the imported member the binder bound [`token`](paramref) to: an imported method,
    /// property, field or event.
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token naming a member or a call.
    /// @returns The member symbol, or null when the token does not name an imported member.
    func GetImportedSymbol(compilation Compilation?, token SyntaxToken?) Symbol? {
        let bound = Bind(compilation, token, matchStaleTree: false)
        if bound == nil {
            return nil
        }
        let symbol = bound.Model.GetSymbolInfo(bound.Token).Symbol
        return if IsImportedMember(symbol) {
            symbol
        } else {
            default(Symbol?)
        }
    }

    /// Gets the candidates the call or member name at [`token`](paramref) resolved among.
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token naming a call or a member.
    /// @returns The candidates in the order of (cref:SemanticModel.GetMemberGroup), empty when the binder has no answer.
    func GetMemberGroup(compilation Compilation?, token SyntaxToken?) ImmutableArray[Symbol] {
        let bound = Bind(compilation, token, matchStaleTree: false)
        if bound == nil {
            return ImmutableArray[Symbol].Empty
        }
        return bound.Model.GetMemberGroup(bound.Token)
    }

    /// Gets the members of [`type`](paramref) that a member access at [`position`](paramref) of
    /// [`tree`](paramref) can name.
    /// @param compilation The compilation to query.
    /// @param tree The tree of the position, possibly a stale parse of the file.
    /// @param position A character offset into [`tree`](paramref).
    /// @param type The receiver type.
    /// @param name When given, only the members of this name.
    /// @returns The members in the order of (cref:SemanticModel.LookupMembers), empty when the compilation holds no tree of the file.
    func LookupMembers(
        compilation Compilation?,
        tree SyntaxTree?,
        position int32,
        type TypeSymbol,
        name string? = nil
    ) ImmutableArray[Symbol] {
        if compilation == nil {
            return ImmutableArray[Symbol].Empty
        }
        let model = GetPositionModel(compilation, tree)
        if model == nil {
            return ImmutableArray[Symbol].Empty
        }
        return model.LookupMembers(position, type, name)
    }

    /// Tells whether [`symbol`](paramref) stands for a member of an imported CLR type.
    func IsImportedMember(symbol Symbol?) bool -> switch symbol {
        case ImportedFunctionSymbol _: true
        case property is PropertySymbol: property.ImportedMember != nil
        case field is FieldSymbol: field.ImportedMember != nil
        case clrEvent is EventSymbol: clrEvent.ImportedMember != nil
        default: false
    }

    /// Tells whether [`symbol`](paramref) is an extension: an extension function declared in source, or an
    /// imported static method marked with the extension attribute.
    func IsExtensionMember(symbol Symbol?) bool -> switch symbol {
        case function is ImportedFunctionSymbol: HasExtensionAttribute(function.Method)
        case function is FunctionSymbol: function.IsExtension
        default: false
    }

    /// Tells whether [`member`](paramref), as [`LookupMembers`](cref:LookupMembers) listed it for
    /// [`receiver`](paramref), is an extension appended for the receiver, which a call writes on a value.
    /// A static method of the receiver's own class that carries the extension attribute (`Enumerable.Select`
    /// on `Enumerable`) is a static member of its type, not an extension of it.
    func IsReceiverExtension(member Symbol?, receiver TypeSymbol) bool {
        if !IsExtensionMember(member) {
            return false
        }
        if member is ImportedFunctionSymbol imported {
            var type = receiver
            while type is NullableTypeSymbol or PlatformTypeSymbol {
                type = if type is NullableTypeSymbol nullable {
                    nullable.UnderlyingType
                } else {
                    cast[PlatformTypeSymbol](type).UnderlyingType
                }
            }
            let owner = imported.Method.DeclaringType
            let own = type.ClrType
            return owner == nil || own == nil || !string.Equals(owner.FullName, own.FullName, StringComparison.Ordinal)
        }
        return true
    }

    // The attribute is read as metadata, by name: a method of a project's reference set comes from a
    // MetadataLoadContext, where IsDefined is not supported (as in the compiler's own check).
    private func HasExtensionAttribute(method MethodInfo) bool {
        if !method.IsStatic {
            return false
        }
        try {
            return method.GetCustomAttributesData().Any(
                (attribute CustomAttributeData) -> attribute.AttributeType.FullName ==
                "System.Runtime.CompilerServices.ExtensionAttribute"
            )
        } catch (Exception) {
            return false
        }
    }

    /// Gets the reflected member behind an imported member symbol, for documentation and for
    /// cross-assembly definitions, until imported symbols carry handles (ADR-0209 stage 6).
    func GetMemberInfo(symbol Symbol?) MemberInfo? -> switch symbol {
        case function is ImportedFunctionSymbol: function.Method
        case property is PropertySymbol: property.ImportedMember
        case field is FieldSymbol: field.ImportedMember
        case clrEvent is EventSymbol: clrEvent.ImportedMember
        default: default(MemberInfo?)
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
                if ServerPathIdentity.AreSame(candidate.Text?.FileName, fileName) &&
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
