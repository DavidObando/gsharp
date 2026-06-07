// <copyright file="ImportedClrMemberResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.LanguageServer;

/// <summary>
/// Resolves an identifier token under the cursor to its underlying CLR
/// <see cref="Type"/> or <see cref="MemberInfo"/>, when no G# user-defined
/// symbol matches.
/// </summary>
/// <remarks>
/// This is used by cross-project Go-to-Definition when the token lands on
/// either an imported type name (e.g. <c>Console</c>) or a member access on
/// an imported type (e.g. <c>Console.WriteLine</c>). The path mirrors
/// <c>HoverComputer.BuildImportedClrModel</c> intentionally: when the hover
/// can describe a CLR member at a position, Go-to-Definition should be able
/// to jump to it. The implementation intentionally only handles the chains
/// whose intermediates are CLR types (the common case for Console/HttpClient/
/// .NET BCL navigation); chains where an intermediate is a user-defined G#
/// struct fall through to <see langword="false"/> and the caller's existing
/// G#-member path takes over.
/// </remarks>
internal static class ImportedClrMemberResolver
{
    /// <summary>
    /// Attempts to resolve the identifier under <paramref name="token"/> to an
    /// imported CLR <see cref="Type"/>. Covers bare type-name tokens like the
    /// <c>Console</c> in <c>Console.WriteLine</c>.
    /// </summary>
    /// <param name="tree">The syntax tree providing import context.</param>
    /// <param name="compilation">The compilation.</param>
    /// <param name="token">The token under the cursor.</param>
    /// <param name="type">The resolved CLR type on success.</param>
    /// <returns>True when a CLR type was resolved.</returns>
    public static bool TryResolveClrType(SyntaxTree tree, Compilation compilation, SyntaxToken token, out Type type)
    {
        type = null;
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var includeAttributeSuffixFallback = IsAnnotationNameToken(tree.Root, token);
        type = SemanticLookup.ResolveImportedClrType(tree, compilation, token.Text, includeAttributeSuffixFallback);
        return type != null;
    }

    /// <summary>
    /// Attempts to resolve the identifier under <paramref name="token"/> to a
    /// CLR <see cref="MemberInfo"/> on an imported type. Covers member-access
    /// RHS tokens like the <c>WriteLine</c> in <c>Console.WriteLine</c>.
    /// </summary>
    /// <param name="tree">The syntax tree providing context.</param>
    /// <param name="compilation">The compilation.</param>
    /// <param name="token">The token under the cursor.</param>
    /// <param name="member">The resolved member on success.</param>
    /// <returns>True when a CLR member was resolved.</returns>
    public static bool TryResolveClrMember(SyntaxTree tree, Compilation compilation, SyntaxToken token, out MemberInfo member)
    {
        member = null;
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        foreach (var context in FindAccessorMemberContexts(tree, token))
        {
            if (!TryResolveClrReceiver(tree, compilation, context.ReceiverExpression, out var receiverType, out var staticMembers))
            {
                continue;
            }

            var flags = BindingFlags.Public | (staticMembers ? BindingFlags.Static : BindingFlags.Instance);

            var property = ClrTypeUtilities.SafeGetProperty(receiverType, context.MemberName, flags);
            if (property != null && property.GetIndexParameters().Length == 0)
            {
                member = property;
                return true;
            }

            var field = ClrTypeUtilities.SafeGetField(receiverType, context.MemberName, flags);
            if (field != null)
            {
                member = field;
                return true;
            }

            var @event = ClrTypeUtilities.SafeGetEvent(receiverType, context.MemberName, flags);
            if (@event != null)
            {
                member = @event;
                return true;
            }

            var methods = ClrTypeUtilities.SafeGetMethods(receiverType, flags)
                .Where(m => m.Name == context.MemberName && !m.IsSpecialName)
                .ToArray();
            if (methods.Length > 0)
            {
                member = methods[0];
                return true;
            }
        }

        return false;
    }

    private static bool TryResolveClrReceiver(SyntaxTree tree, Compilation compilation, ExpressionSyntax expression, out Type receiverType, out bool staticMembers)
    {
        receiverType = null;
        staticMembers = false;
        switch (expression)
        {
            case NameExpressionSyntax name:
                var nameSymbol = SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken);
                if (TryGetClrTypeFromSymbol(nameSymbol, out receiverType))
                {
                    staticMembers = false;
                    return true;
                }

                var imported = SemanticLookup.ResolveImportedClrType(tree, compilation, name.IdentifierToken.Text);
                if (imported != null)
                {
                    receiverType = imported;
                    staticMembers = true;
                    return true;
                }

                return false;

            case CallExpressionSyntax call:
                var callSymbol = SemanticLookup.ResolveSymbol(compilation, call.Identifier);
                if (TryGetClrTypeFromSymbol(callSymbol, out receiverType))
                {
                    staticMembers = false;
                    return true;
                }

                return false;

            case AccessorExpressionSyntax accessor:
                // Chained access — walk the chain: receiver type of `a.b.c`
                // for cursor on `c` requires the type of `a.b`. We resolve
                // the left part's receiver first, then look up the member's
                // type on it.
                if (!TryGetAccessorMemberName(accessor.RightPart, out var intermediateName))
                {
                    return false;
                }

                if (!TryResolveClrReceiver(tree, compilation, accessor.LeftPart, out var outerType, out var outerStatic))
                {
                    return false;
                }

                var outerFlags = BindingFlags.Public | (outerStatic ? BindingFlags.Static : BindingFlags.Instance);
                receiverType = ResolveMemberReturnType(outerType, intermediateName, outerFlags);
                staticMembers = false;
                return receiverType != null;

            default:
                return false;
        }
    }

    private static Type ResolveMemberReturnType(Type receiverType, string memberName, BindingFlags flags)
    {
        if (receiverType == null)
        {
            return null;
        }

        var property = ClrTypeUtilities.SafeGetProperty(receiverType, memberName, flags);
        if (property != null && property.GetIndexParameters().Length == 0)
        {
            return property.PropertyType;
        }

        var field = ClrTypeUtilities.SafeGetField(receiverType, memberName, flags);
        if (field != null)
        {
            return field.FieldType;
        }

        var @event = ClrTypeUtilities.SafeGetEvent(receiverType, memberName, flags);
        if (@event != null)
        {
            return @event.EventHandlerType;
        }

        var method = ClrTypeUtilities.SafeGetMethods(receiverType, flags)
            .FirstOrDefault(m => m.Name == memberName && !m.IsSpecialName);
        return method?.ReturnType;
    }

    private static bool TryGetClrTypeFromSymbol(Symbol symbol, out Type clrType)
    {
        clrType = symbol switch
        {
            ImportedClassSymbol importedClass => importedClass.ClassType,
            ImportedTypeSymbol importedType => importedType.Type,
            TypeSymbol typeSymbol => typeSymbol.ClrType,
            VariableSymbol variable => variable.Type?.ClrType,
            PropertySymbol property => property.Type?.ClrType,
            FieldSymbol field => field.Type?.ClrType,
            EventSymbol @event => @event.Type?.ClrType,
            FunctionSymbol function => function.Type?.ClrType,
            ImportedFunctionSymbol function => function.Type?.ClrType,
            _ => null,
        };

        return clrType != null;
    }

    private static bool TryGetAccessorMemberName(ExpressionSyntax expression, out string memberName)
    {
        memberName = expression switch
        {
            NameExpressionSyntax name => name.IdentifierToken.Text,
            CallExpressionSyntax call => call.Identifier.Text,
            _ => null,
        };

        return memberName != null;
    }

    private static IEnumerable<(ExpressionSyntax ReceiverExpression, string MemberName)> FindAccessorMemberContexts(SyntaxTree tree, SyntaxToken token)
    {
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            yield break;
        }

        foreach (var accessor in FindNodes<AccessorExpressionSyntax>(tree.Root)
                     .Where(a => a.RightPart.Span.Start <= token.Span.Start && token.Span.End <= a.RightPart.Span.End)
                     .OrderBy(a => a.Span.Length))
        {
            if (TryResolveAccessorMemberContext(tree, accessor.RightPart, accessor.LeftPart, token, out var receiverExpression, out var memberName))
            {
                yield return (receiverExpression, memberName);
            }
        }
    }

    private static bool TryResolveAccessorMemberContext(
        SyntaxTree tree,
        ExpressionSyntax expression,
        ExpressionSyntax receiver,
        SyntaxToken token,
        out ExpressionSyntax receiverExpression,
        out string memberName)
    {
        receiverExpression = null;
        memberName = null;

        switch (expression)
        {
            case NameExpressionSyntax name when MatchesToken(name.IdentifierToken, token):
                receiverExpression = receiver;
                memberName = name.IdentifierToken.Text;
                return true;
            case CallExpressionSyntax call when MatchesToken(call.Identifier, token):
                receiverExpression = receiver;
                memberName = call.Identifier.Text;
                return true;
            case AccessorExpressionSyntax nested:
                if (TryResolveAccessorMemberContext(tree, nested.LeftPart, receiver, token, out receiverExpression, out memberName))
                {
                    return true;
                }

                var nestedReceiver = new AccessorExpressionSyntax(tree, receiver, nested.DotToken, nested.LeftPart);
                return TryResolveAccessorMemberContext(tree, nested.RightPart, nestedReceiver, token, out receiverExpression, out memberName);
            default:
                return false;
        }
    }

    private static bool MatchesToken(SyntaxToken candidate, SyntaxToken token)
    {
        return ReferenceEquals(candidate, token)
            || (candidate != null && token != null
                && candidate.Span.Start == token.Span.Start
                && candidate.Span.End == token.Span.End
                && string.Equals(candidate.Text, token.Text, StringComparison.Ordinal));
    }

    private static bool IsAnnotationNameToken(SyntaxNode root, SyntaxToken token)
    {
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        foreach (var annotation in FindNodes<AnnotationSyntax>(root))
        {
            foreach (var segment in annotation.NameSegments)
            {
                if (MatchesToken(segment, token))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static IEnumerable<T> FindNodes<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        if (root is T matched)
        {
            yield return matched;
        }

        foreach (var child in root.GetChildren())
        {
            foreach (var descendant in FindNodes<T>(child))
            {
                yield return descendant;
            }
        }
    }
}
