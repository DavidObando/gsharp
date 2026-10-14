// <copyright file="ImportedClrMemberResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq
import System.Reflection

/// Resolves an identifier token under the cursor to its underlying CLR
/// (cref:Type) or (cref:MemberInfo), when no G# user-defined
/// symbol matches.
/// @remarks This is used by cross-project Go-to-Definition when the token lands on
/// either an imported type name (e.g. `Console`) or a member access on
/// an imported type (e.g. `Console.WriteLine`). The path mirrors
/// `HoverComputer.BuildImportedClrModel` intentionally: when the hover
/// can describe a CLR member at a position, Go-to-Definition should be able
/// to jump to it. The implementation intentionally only handles the chains
/// whose intermediates are CLR types (the common case for Console/HttpClient/
/// .NET BCL navigation); chains where an intermediate is a user-defined G#
/// struct fall through to `false` and the caller's existing
/// G#-member path takes over.
internal shared class ImportedClrMemberResolver {
    /// Attempts to resolve the identifier under [`token`](paramref) to an
    /// imported CLR (cref:Type). Covers bare type-name tokens like the
    /// `Console` in `Console.WriteLine`.
    /// @param tree The syntax tree providing import context.
    /// @param compilation The compilation.
    /// @param token The token under the cursor.
    /// @param type The resolved CLR type on success.
    /// @returns True when a CLR type was resolved.
    func TryResolveClrType(tree SyntaxTree, compilation Compilation, token SyntaxToken?, out type Type?) bool {
        type = nil
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        let includeAttributeSuffixFallback = IsAnnotationNameToken(tree.Root, token)
        type = SemanticLookup.ResolveImportedClrType(tree, compilation, token.Text, includeAttributeSuffixFallback)
        return type != nil
    }

    /// Attempts to resolve the identifier under [`token`](paramref) to a
    /// CLR (cref:MemberInfo) on an imported type. Covers member-access
    /// RHS tokens like the `WriteLine` in `Console.WriteLine`.
    /// @param tree The syntax tree providing context.
    /// @param compilation The compilation.
    /// @param token The token under the cursor.
    /// @param member The resolved member on success.
    /// @returns True when a CLR member was resolved.
    func TryResolveClrMember(
        tree SyntaxTree,
        compilation Compilation,
        token SyntaxToken?,
        out member MemberInfo?
    ) bool {
        member = nil
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        for context in FindAccessorMemberContexts(tree, token) {
            if !TryResolveClrReceiver(
                tree,
                compilation,
                context.ReceiverExpression,
                out var receiverType,
                out var staticMembers
            ) ||
                receiverType == nil {
                continue
            }
            let flags = BindingFlags.Public | (
                if staticMembers {
                    BindingFlags.Static
                } else {
                    BindingFlags.Instance
                }
            )
            let property PropertyInfo? = ClrTypeUtilities.SafeGetProperty(receiverType, context.MemberName, flags)
            if property != nil && property.GetIndexParameters().Length == 0 {
                member = property
                return true
            }
            let field FieldInfo? = ClrTypeUtilities.SafeGetField(receiverType, context.MemberName, flags)
            if field != nil {
                member = field
                return true
            }
            let event EventInfo? = ClrTypeUtilities.SafeGetEvent(receiverType, context.MemberName, flags)
            if event != nil {
                member = event
                return true
            }
            let methods = ClrTypeUtilities
                .SafeGetMethods(receiverType, flags)
                .Where((m MethodInfo) -> m.Name == context.MemberName && !m.IsSpecialName)
                .ToArray()
            if methods.Length > 0 {
                member = methods[0]
                return true
            }
        }
        return false
    }

    private func TryResolveClrReceiver(
        tree SyntaxTree,
        compilation Compilation,
        expression ExpressionSyntax,
        out receiverType Type?,
        out staticMembers bool
    ) bool {
        receiverType = nil
        staticMembers = false
        switch expression {
            case name is NameExpressionSyntax {
                let nameSymbol = SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken)
                if TryGetClrTypeFromSymbol(nameSymbol, out receiverType) {
                    staticMembers = false
                    return true
                }
                let imported Type? = SemanticLookup.ResolveImportedClrType(tree, compilation, name.IdentifierToken.Text)
                if imported != nil {
                    receiverType = imported
                    staticMembers = true
                    return true
                }
                return false
            }
            case call is CallExpressionSyntax {
                let callSymbol = SemanticLookup.ResolveSymbol(compilation, call.Identifier)
                if TryGetClrTypeFromSymbol(callSymbol, out receiverType) {
                    staticMembers = false
                    return true
                }
                return false
            }
            case accessor is AccessorExpressionSyntax {
                // Chained access — walk the chain: receiver type of `a.b.c`
                // for cursor on `c` requires the type of `a.b`. We resolve
                // the left part's receiver first, then look up the member's
                // type on it.
                if !TryGetAccessorMemberName(accessor.RightPart, out var intermediateName) || intermediateName == nil {
                    return false
                }
                if !TryResolveClrReceiver(
                    tree,
                    compilation,
                    accessor.LeftPart,
                    out var outerType,
                    out var outerStatic
                ) ||
                    outerType == nil {
                    return false
                }
                let outerFlags = BindingFlags.Public | (
                    if outerStatic {
                        BindingFlags.Static
                    } else {
                        BindingFlags.Instance
                    }
                )
                receiverType = ResolveMemberReturnType(outerType, intermediateName, outerFlags)
                staticMembers = false
                return receiverType != nil
            }
            default {
                return false
            }
        }
    }

    private func ResolveMemberReturnType(receiverType Type?, memberName string, flags BindingFlags) Type? {
        if receiverType == nil {
            return nil
        }
        let property PropertyInfo? = ClrTypeUtilities.SafeGetProperty(receiverType, memberName, flags)
        if property != nil && property.GetIndexParameters().Length == 0 {
            return property.PropertyType
        }
        let field FieldInfo? = ClrTypeUtilities.SafeGetField(receiverType, memberName, flags)
        if field != nil {
            return field.FieldType
        }
        let event EventInfo? = ClrTypeUtilities.SafeGetEvent(receiverType, memberName, flags)
        if event != nil {
            return event.EventHandlerType
        }
        let method = ClrTypeUtilities.SafeGetMethods(receiverType, flags).FirstOrDefault(
            (m MethodInfo) -> m.Name == memberName && !m.IsSpecialName
        )
        return method?.ReturnType
    }

    private func TryGetClrTypeFromSymbol(symbol Symbol?, out clrType Type?) bool {
        clrType = switch symbol {
            case importedClass is ImportedClassSymbol: importedClass.ClassType
            case importedType is ImportedTypeSymbol: importedType.Type
            case typeSymbol is TypeSymbol: typeSymbol.ClrType
            case variable is VariableSymbol: variable.Type?.ClrType
            case property is PropertySymbol: property.Type?.ClrType
            case field is FieldSymbol: field.Type?.ClrType
            case event is EventSymbol: event.Type?.ClrType
            case function is FunctionSymbol: function.Type?.ClrType
            case function is ImportedFunctionSymbol: function.Type?.ClrType
            default: default(Type?)
        }
        return clrType != nil
    }

    private func TryGetAccessorMemberName(expression ExpressionSyntax, out memberName string?) bool {
        memberName = switch expression {
            case name is NameExpressionSyntax: name.IdentifierToken.Text
            case call is CallExpressionSyntax: call.Identifier.Text
            default: default(string?)
        }
        return memberName != nil
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
