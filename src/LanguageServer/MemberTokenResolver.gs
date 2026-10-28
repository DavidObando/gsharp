// <copyright file="MemberTokenResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Resolves an identifier token under the cursor to the member it names, or to the imported CLR
/// type it names, when no G# declaration matches the token.
/// @remarks Hover and Go-to-Definition use it on a type name such as `Console` and on a member
/// access such as `Console.WriteLine`. The member comes from the semantic model: the symbol the
/// binder bound the token to, else the members of the receiver's type (ADR-0212 slice S4,
/// `SemanticModel.LookupMembers`). The receiver type is the bound type of the receiver expression,
/// else the type that its name or call names. This replaces the reflection walk of the former
/// `ImportedClrMemberResolver`.
internal shared class MemberTokenResolver {
    /// Attempts to resolve the identifier under [`token`](paramref) to an imported CLR type. Covers
    /// bare type-name tokens like the `Console` in `Console.WriteLine`.
    /// @param tree The syntax tree providing import context.
    /// @param compilation The compilation.
    /// @param token The token under the cursor.
    /// @param type The resolved CLR type on success.
    /// @returns True when a CLR type was resolved.
    func TryResolveImportedType(tree SyntaxTree, compilation Compilation, token SyntaxToken?, out type Type?) bool {
        type = nil
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        let includeAttributeSuffixFallback = IsAnnotationNameToken(tree.Root, token)
        type = SemanticLookup.ResolveImportedClrType(tree, compilation, token.Text, includeAttributeSuffixFallback)
        return type != nil
    }

    /// Attempts to resolve [`token`](paramref) to a member of a receiver: a member selected with
    /// `receiver.Member`, or a property of an object initializer. A member of an imported type is
    /// answered only when the receiver is the right kind, a type name for a static member and a value for
    /// an instance member.
    /// @param tree The syntax tree providing context.
    /// @param compilation The compilation.
    /// @param token The token under the cursor.
    /// @param member The member symbol on success.
    /// @param overloadCount How many overloads the member name has on the receiver, 1 for a member that is not a method.
    /// @returns True when a member was resolved.
    func TryResolveMember(
        tree SyntaxTree,
        compilation Compilation,
        token SyntaxToken?,
        out member Symbol?,
        out overloadCount int32
    ) bool {
        member = nil
        overloadCount = 0
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        // The member the binder bound the token to, when it has one.
        let bound = BoundSemantics.GetImportedSymbol(compilation, token)
        if bound != nil {
            member = bound
            overloadCount = Math.Max(1, BoundSemantics.GetMemberGroup(compilation, token).Length)
            return true
        }
        for context in FindAccessorMemberContexts(tree, token).Concat(
            FindObjectInitializerMemberContexts(tree, token)
        ) {
            var receiver ResolvedReceiver? = nil
            if token.Parent?.Parent is MemberCollectionElementSyntax {
                if InferInitializerReceiverType(tree, compilation, context.ReceiverExpression) is {} initializerType {
                    receiver = ResolvedReceiver(initializerType, StaticMembers: false)
                }
            } else {
                receiver = ResolveReceiver(tree, compilation, context.ReceiverExpression)
            }
            if receiver == nil {
                continue
            }
            let candidates = BoundSemantics.LookupMembers(
                compilation,
                tree,
                token.Span.Start,
                receiver.Type,
                context.MemberName
            )
            let receiverType = receiver.Type
            let chosen = Choose(candidates, receiver.StaticMembers, receiverType)
            if chosen != nil {
                member = chosen
                overloadCount = if chosen is FunctionSymbol or ImportedFunctionSymbol {
                    // The extensions of the same name are other methods, counted with an extension only.
                    candidates.Count(
                        (c Symbol) -> c is FunctionSymbol or
                            ImportedFunctionSymbol &&
                            IsStatic(c, receiverType) == IsStatic(chosen, receiverType) &&
                            BoundSemantics.IsReceiverExtension(c, receiverType) ==
                        BoundSemantics.IsReceiverExtension(chosen, receiverType)
                    )
                } else {
                    1
                }
                return true
            }
        }
        return false
    }

    /// Attempts to resolve [`token`](paramref) to a member of an imported CLR type, as the reflected
    /// member.
    /// @param tree The syntax tree providing context.
    /// @param compilation The compilation.
    /// @param token The token under the cursor.
    /// @param member The reflected member on success.
    /// @returns True when an imported member was resolved.
    func TryResolveImportedMember(
        tree SyntaxTree,
        compilation Compilation,
        token SyntaxToken?,
        out member MemberInfo?
    ) bool {
        member = nil
        if TryResolveMember(tree, compilation, token, out var symbol, out _) && symbol != nil {
            member = BoundSemantics.GetMemberInfo(symbol)
        }
        return member != nil
    }

    /// Tells whether [`member`](paramref), listed for [`receiver`](paramref), is a static member of its type.
    /// An extension appended for the receiver is called on a value, so it is an instance member.
    func IsStatic(member Symbol, receiver TypeSymbol) bool -> switch member {
        case field is FieldSymbol: field.IsStatic
        case property is PropertySymbol: property.IsStatic
        case clrEvent is EventSymbol: clrEvent.IsStatic
        case function is ImportedFunctionSymbol: function.Method.IsStatic && !BoundSemantics.IsReceiverExtension(
            function,
            receiver
        )
        case function is FunctionSymbol: !function.IsExtension && (function.IsStatic || function.StaticOwnerType != nil)
        case EnumMemberSymbol _: true
        default: false
    }

    // A property, then a field, then an event, then the first method: the order of the former
    // reflection walk. Members of an imported type must match the receiver kind; a source member need not.
    private func Choose(candidates ImmutableArray[Symbol], staticMembers bool, receiver TypeSymbol) Symbol? {
        // The nearest declaring type wins before the kind does: a derived field hides a base property.
        let nearest = candidates.FirstOrDefault()?.ContainingType
        let ofNearest = if nearest == nil {
            candidates
        } else {
            candidates.Where((c Symbol) -> c.ContainingType == nil || object.ReferenceEquals(c.ContainingType, nearest))
                .ToImmutableArray()
        }
        // An extension is called on a value, never on the type name.
        let usable = ofNearest.Where(
            (c Symbol) -> (!BoundSemantics.IsImportedMember(c) || IsStatic(c, receiver) == staticMembers) &&
                !(staticMembers && BoundSemantics.IsReceiverExtension(c, receiver))
        )
            .ToList()
        let preferred = usable.Where((c Symbol) -> IsStatic(c, receiver) == staticMembers).ToList()
        let pool = if preferred.Count > 0 {
            preferred
        } else {
            usable
        }
        return pool.FirstOrDefault((c Symbol) -> c is PropertySymbol) ?? pool.FirstOrDefault(
            (c Symbol) -> c is FieldSymbol
        ) ??
            pool.FirstOrDefault((c Symbol) -> c is EventSymbol) ?? pool.FirstOrDefault(
            (c Symbol) -> c is FunctionSymbol or ImportedFunctionSymbol
        ) ??
            pool.FirstOrDefault()
    }

    /// The type that a receiver expression has, and whether the expression names the type itself.
    private data class ResolvedReceiver(Type TypeSymbol, StaticMembers bool) : IEquatable[ResolvedReceiver] { }

    private func ResolveReceiver(
        tree SyntaxTree,
        compilation Compilation,
        expression ExpressionSyntax
    ) ResolvedReceiver? {
        // A value receiver's bound (flow) type first.
        if BoundSemantics.GetExpressionType(compilation, expression) is {} boundType {
            return ResolvedReceiver(boundType, StaticMembers: false)
        }
        switch expression {
            case name is NameExpressionSyntax {
                let symbol = SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken)
                if symbol is TypeSymbol typeName {
                    return ResolvedReceiver(typeName, StaticMembers: true)
                }
                if TypeOfValue(symbol) is {} valueType {
                    return ResolvedReceiver(valueType, StaticMembers: false)
                }
                return ImportedTypeByName(tree, compilation, name.IdentifierToken.Text, StaticMembers: true)
            }
            case call is CallExpressionSyntax {
                let callee = SemanticLookup.ResolveSymbol(compilation, call.Identifier)
                // A constructor call of a source type constructs an instance.
                if callee is StructSymbol constructed {
                    return ResolvedReceiver(constructed, StaticMembers: false)
                }
                if TypeOfValue(callee) is {} callType {
                    return ResolvedReceiver(callType, StaticMembers: false)
                }
                // A constructor call on an imported CLR type whose identifier does not resolve to a
                // symbol: the type by name gives the instance members of the constructed object.
                return ImportedTypeByName(tree, compilation, call.Identifier.Text, StaticMembers: false)
            }
            case accessor is AccessorExpressionSyntax {
                // A chain: the receiver of `a.b.c` for `c` is the type of the member `b` of `a`.
                if accessor.RightPart is not(NameExpressionSyntax or CallExpressionSyntax) {
                    return nil
                }
                let memberName = switch accessor.RightPart {
                    case name is NameExpressionSyntax: name.IdentifierToken.Text
                    case call is CallExpressionSyntax: call.Identifier.Text
                    default: string.Empty
                }
                let outer = ResolveReceiver(tree, compilation, accessor.LeftPart)
                if outer == nil {
                    return nil
                }
                let members = BoundSemantics.LookupMembers(
                    compilation,
                    tree,
                    accessor.RightPart.Span.Start,
                    outer.Type,
                    memberName
                )
                if Choose(members, outer.StaticMembers, outer.Type) is {} intermediate &&
                    TypeOfValue(intermediate) is {} memberType {
                    return ResolvedReceiver(memberType, StaticMembers: false)
                }
                return nil
            }
            default {
                return nil
            }
        }
    }

    private func ImportedTypeByName(
        tree SyntaxTree,
        compilation Compilation,
        name string,
        StaticMembers bool
    ) ResolvedReceiver? {
        let imported Type? = SemanticLookup.ResolveImportedClrType(tree, compilation, name)
        return if imported == nil {
            default(ResolvedReceiver?)
        } else {
            ResolvedReceiver(ImportedTypeSymbol.Get(imported), StaticMembers)
        }
    }

    // The type that reading a variable, property, field or event, or calling a function, gives.
    private func TypeOfValue(symbol Symbol?) TypeSymbol? -> switch symbol {
        case variable is VariableSymbol: variable.Type
        case property is PropertySymbol: property.Type
        case field is FieldSymbol: field.Type
        case clrEvent is EventSymbol: clrEvent.Type
        case function is FunctionSymbol: function.Type
        case function is ImportedFunctionSymbol: function.Type
        default: default(TypeSymbol?)
    }

    /// Infers the type that an object initializer constructs from its target expression.
    private func InferInitializerReceiverType(
        tree SyntaxTree,
        compilation Compilation,
        target ExpressionSyntax
    ) TypeSymbol? {
        return BoundSemantics
            .GetPositionModel(compilation, tree)
            ?.GetSpeculativeTypeInfo(target.Span.Start, target)
            .Type
    }

    private func FindAccessorMemberContexts(tree SyntaxTree, token SyntaxToken?) sequence[
        (ReceiverExpression ExpressionSyntax, MemberName string)
    ] {
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            yield break
        }
        for accessor in FindNodes[AccessorExpressionSyntax](tree.Root).Where(
            (a AccessorExpressionSyntax) -> a
                .RightPart
                .Span
                .Start <= token
                .Span
                .Start &&
                token
                .Span
                .End <= a
                .RightPart
                .Span
                .End
        )
            .OrderBy((a AccessorExpressionSyntax) -> a.Span.Length) {
            if TryResolveAccessorMemberContext(
                tree,
                accessor.RightPart,
                accessor.LeftPart,
                token,
                out var receiverExpression,
                out var memberName
            ) &&
                receiverExpression != nil &&
                memberName != nil {
                yield(receiverExpression, memberName)
            }
        }
    }

    /// Yields the member context of a token that names a property of an object initializer
    /// (`T(args) { Prop = v }`). The receiver is the constructor call whose constructed type the
    /// property is looked up on.
    private func FindObjectInitializerMemberContexts(tree SyntaxTree, token SyntaxToken?) sequence[
        (ReceiverExpression ExpressionSyntax, MemberName string)
    ] {
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            yield break
        }
        for creation in FindNodes[ObjectCreationExpressionSyntax](tree.Root) {
            for initializer in creation.Initializers {
                if MatchesToken(initializer.PropertyIdentifier, token) {
                    if creation.Target != nil {
                        yield(creation.Target!!, initializer.PropertyIdentifier.Text)
                    }
                }
            }
        }
        for collection in FindNodes[CollectionInitializerExpressionSyntax](tree.Root) {
            for member in collection.Elements.OfType[MemberCollectionElementSyntax]() {
                if MatchesToken(member.Initializer.FieldIdentifier, token) && SemanticLookup.GetInitializerTarget(
                    collection
                ) is {} target {
                    yield(target, member.Initializer.FieldIdentifier.ValueText)
                }
            }
        }
    }

    private func TryResolveAccessorMemberContext(
        tree SyntaxTree,
        expression ExpressionSyntax,
        receiver ExpressionSyntax,
        token SyntaxToken,
        out receiverExpression ExpressionSyntax?,
        out memberName string?
    ) bool {
        receiverExpression = nil
        memberName = nil
        switch expression {
            case name is NameExpressionSyntax when MatchesToken(name.IdentifierToken, token) {
                receiverExpression = receiver
                memberName = name.IdentifierToken.Text
                return true
            }
            case call is CallExpressionSyntax when MatchesToken(call.Identifier, token) {
                receiverExpression = receiver
                memberName = call.Identifier.Text
                return true
            }
            case nested is AccessorExpressionSyntax {
                if TryResolveAccessorMemberContext(
                    tree,
                    nested.LeftPart,
                    receiver,
                    token,
                    out receiverExpression,
                    out memberName
                ) {
                    return true
                }
                // Rebuild the left prefix as a receiver expression for the nested right segment.
                let nestedReceiver = AccessorExpressionSyntax(tree, receiver, nested.DotToken, nested.LeftPart)
                return TryResolveAccessorMemberContext(
                    tree,
                    nested.RightPart,
                    nestedReceiver,
                    token,
                    out receiverExpression,
                    out memberName
                )
            }
            default {
                return false
            }
        }
    }

    private func MatchesToken(candidate SyntaxToken?, token SyntaxToken?) bool {
        return object.ReferenceEquals(candidate, token) ||
            (
            candidate != nil &&
                token != nil &&
                candidate
                .Span
                .Start == token
                .Span
                .Start &&
                candidate
                .Span
                .End == token
                .Span
                .End &&
                string.Equals(candidate.Text, token.Text, StringComparison.Ordinal)
        )
    }

    private func IsAnnotationNameToken(root SyntaxNode, token SyntaxToken?) bool {
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        for annotation in FindNodes[AnnotationSyntax](root) {
            for segment in annotation.NameSegments {
                if MatchesToken(segment, token) {
                    return true
                }
            }
        }
        return false
    }

    private func FindNodes[T SyntaxNode](root SyntaxNode) sequence[T] {
        if root is T matched {
            yield matched
        }
        for child in root.GetChildren() {
            for descendant in FindNodes[T](child) {
                yield descendant
            }
        }
    }
}
