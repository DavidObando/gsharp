// <copyright file="LspFeatureComputers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.LanguageServer.Protocol;
using LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

public static class HoverComputer
{
    public static Hover ComputeHover(DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        // When the token isn't directly in the semantic model (e.g. member access
        // on a user-defined type like person.Name), try resolving through the
        // accessor expression's receiver type.
        if (symbol == null)
        {
            symbol = TryResolveGSharpMember(content.SyntaxTree, compilation, token);
        }

        var model = symbol != null
            ? BuildHoverModel(symbol, compilation)
            : BuildImportedClrModel(content.SyntaxTree, compilation, token);

        // Literal tokens (numbers, strings, booleans) show their inferred type.
        if (model == null)
        {
            model = BuildLiteralModel(token);
        }

        if (model == null)
        {
            return null;
        }

        return new Hover
        {
            Contents = new MarkedStringsOrMarkupContent(new MarkupContent
            {
                Kind = MarkupKind.Markdown,
                Value = RenderHover(model),
            }),
            Range = SemanticLookup.ToRange(token),
        };
    }

    /// <summary>
    /// Renders a symbol's compact signature label for signature help and completion
    /// detail. Hover uses the richer <see cref="SymbolDisplayFormat.Hover"/> form via
    /// <see cref="ComputeHover"/>.
    /// </summary>
    /// <param name="symbol">The symbol to render.</param>
    /// <returns>The compact signature label.</returns>
    public static string FormatSymbol(Symbol symbol)
    {
        return SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature);
    }

    /// <summary>
    /// Renders a symbol's compact signature label, using <paramref name="compilation"/>
    /// to recover a variable's exact declaring keyword.
    /// </summary>
    /// <param name="symbol">The symbol to render.</param>
    /// <param name="compilation">The compilation providing declaration syntax.</param>
    /// <returns>The compact signature label.</returns>
    public static string FormatSymbol(Symbol symbol, Compilation compilation)
    {
        return SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature, compilation);
    }

    private static HoverModel BuildHoverModel(Symbol symbol, Compilation compilation)
    {
        var signature = SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Hover, compilation);
        var overloadCount = symbol is FunctionSymbol function ? CountOverloads(compilation, function) : 1;
        return new HoverModel(signature, BuildDocumentation(symbol), overloadCount);
    }

    private static HoverModel BuildImportedClrModel(SyntaxTree tree, Compilation compilation, SyntaxToken token)
    {
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var clrType = SemanticLookup.ResolveImportedClrType(
            tree,
            compilation,
            token.Text,
            includeAttributeSuffixFallback: IsAnnotationNameToken(tree.Root, token));
        if (clrType != null)
        {
            var signature = SymbolDisplay.ToDisplayString(clrType, SymbolDisplayFormat.Hover);
            var documentation = HoverDocumentationRenderer.Render(
                GSharp.Core.CodeAnalysis.Documentation.AssemblyDocumentationProvider.Resolve(clrType));
            return new HoverModel(signature, documentation, OverloadCount: 1);
        }

        if (!TryResolveClrMember(tree, compilation, token, out var member, out var overloadCount))
        {
            return null;
        }

        return member switch
        {
            PropertyInfo property => new HoverModel(
                SymbolDisplay.ToDisplayString(property, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(GSharp.Core.CodeAnalysis.Documentation.AssemblyDocumentationProvider.Resolve(property)),
                OverloadCount: 1),
            FieldInfo field => new HoverModel(
                SymbolDisplay.ToDisplayString(field, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(GSharp.Core.CodeAnalysis.Documentation.AssemblyDocumentationProvider.Resolve(field)),
                OverloadCount: 1),
            EventInfo @event => new HoverModel(
                SymbolDisplay.ToDisplayString(@event, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(GSharp.Core.CodeAnalysis.Documentation.AssemblyDocumentationProvider.Resolve(@event)),
                OverloadCount: 1),
            MethodInfo method => new HoverModel(
                SymbolDisplay.ToDisplayString(method, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(GSharp.Core.CodeAnalysis.Documentation.AssemblyDocumentationProvider.Resolve(method)),
                overloadCount),
            _ => null,
        };
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

    private static HoverModel BuildLiteralModel(SyntaxToken token)
    {
        if (token == null)
        {
            return null;
        }

        var typeName = token.Kind switch
        {
            SyntaxKind.NumberToken => GetNumericTypeName(token.Value),
            SyntaxKind.StringToken => "string",
            SyntaxKind.InterpolatedStringToken => "string",
            SyntaxKind.TrueKeyword => "bool",
            SyntaxKind.FalseKeyword => "bool",
            _ => null,
        };

        if (typeName == null)
        {
            return null;
        }

        var signature = $"({typeName}) {token.Text}";
        return new HoverModel(signature, Array.Empty<HoverDocSection>(), OverloadCount: 1);
    }

    private static string GetNumericTypeName(object value)
    {
        return value switch
        {
            int => "int32",
            uint => "uint32",
            long => "int64",
            ulong => "uint64",
            float => "float32",
            double => "float64",
            decimal => "decimal",
            _ => "int32",
        };
    }

    private static bool TryResolveClrMember(SyntaxTree tree, Compilation compilation, SyntaxToken token, out MemberInfo member, out int overloadCount)
    {
        member = null;
        overloadCount = 0;

        foreach (var context in FindAccessorMemberContexts(tree, token))
        {
            if (!TryResolveClrReceiver(tree, compilation, context.ReceiverExpression, out var receiver))
            {
                continue;
            }

            var flags = BindingFlags.Public | (receiver.StaticMembers ? BindingFlags.Static : BindingFlags.Instance);
            var property = ClrTypeUtilities.SafeGetProperty(receiver.Type, context.MemberName, flags);
            if (property != null && property.GetIndexParameters().Length == 0)
            {
                member = property;
                overloadCount = 1;
                return true;
            }

            var field = ClrTypeUtilities.SafeGetField(receiver.Type, context.MemberName, flags);
            if (field != null)
            {
                member = field;
                overloadCount = 1;
                return true;
            }

            var @event = ClrTypeUtilities.SafeGetEvent(receiver.Type, context.MemberName, flags);
            if (@event != null)
            {
                member = @event;
                overloadCount = 1;
                return true;
            }

            var methods = ClrTypeUtilities.SafeGetMethods(receiver.Type, flags)
                .Where(m => m.Name == context.MemberName && !m.IsSpecialName)
                .ToArray();
            if (methods.Length == 0)
            {
                continue;
            }

            member = methods[0];
            overloadCount = methods.Length;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Resolves a member access on a user-defined G# type (struct/class).
    /// For example, hovering over <c>Name</c> in <c>person.Name</c> where
    /// <c>person</c> is a G#-defined class resolves to the <see cref="PropertySymbol"/>,
    /// <see cref="FieldSymbol"/>, <see cref="EventSymbol"/>, or <see cref="FunctionSymbol"/>
    /// declared on that type.
    /// </summary>
    private static Symbol TryResolveGSharpMember(SyntaxTree tree, Compilation compilation, SyntaxToken token)
    {
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        // Case 1: member access expression (e.g. var x = person.Name)
        foreach (var context in FindAccessorMemberContexts(tree, token))
        {
            var structSymbol = ResolveReceiverStructSymbol(tree, compilation, context.ReceiverExpression);
            if (structSymbol != null)
            {
                var member = LookupMemberOnStruct(structSymbol, context.MemberName);
                if (member != null)
                {
                    return member;
                }
            }
        }

        // Case 2: field assignment expression (e.g. person.Age = 30)
        var fieldAssignment = FindFieldAssignmentWithHoveredField(tree.Root, token);
        if (fieldAssignment != null)
        {
            var receiverSymbol = SemanticLookup.ResolveSymbol(compilation, fieldAssignment.Receiver);
            var receiverStruct = receiverSymbol switch
            {
                VariableSymbol variable => variable.Type as StructSymbol,
                StructSymbol structSym => structSym,
                _ => null,
            };

            if (receiverStruct != null)
            {
                return LookupMemberOnStruct(receiverStruct, fieldAssignment.FieldIdentifier.Text);
            }
        }

        // Case 3: implicit this — bare identifier inside a struct/class method body
        // that matches a member of the enclosing type (e.g. `Name` instead of `this.Name`).
        var enclosingStruct = FindEnclosingStructSymbol(tree, compilation, token);
        if (enclosingStruct != null)
        {
            var member = LookupMemberOnStruct(enclosingStruct, token.Text);
            if (member != null)
            {
                return member;
            }
        }

        return null;
    }

    private static FieldAssignmentExpressionSyntax FindFieldAssignmentWithHoveredField(SyntaxNode root, SyntaxToken token)
    {
        return FindNodes<FieldAssignmentExpressionSyntax>(root)
            .Where(f => MatchesToken(f.FieldIdentifier, token))
            .FirstOrDefault();
    }

    /// <summary>
    /// Finds the <see cref="StructSymbol"/> for the struct/class whose method body
    /// encloses <paramref name="token"/>, if any. Used for implicit-this resolution.
    /// </summary>
    private static StructSymbol FindEnclosingStructSymbol(SyntaxTree tree, Compilation compilation, SyntaxToken token)
    {
        // Find the innermost StructDeclarationSyntax whose span contains the token.
        var enclosingDecl = FindNodes<StructDeclarationSyntax>(tree.Root)
            .Where(s => s.Span.Start <= token.Span.Start && token.Span.End <= s.Span.End)
            .OrderBy(s => s.Span.Length)
            .FirstOrDefault();

        if (enclosingDecl == null)
        {
            return null;
        }

        // Ensure the token is inside a method body, not in the struct's own declarations.
        var insideMethod = enclosingDecl.Methods
            .Any(m => m.Body != null && m.Body.Span.Start <= token.Span.Start && token.Span.End <= m.Body.Span.End);
        if (!insideMethod)
        {
            return null;
        }

        // Resolve the struct declaration to its symbol.
        var structSymbol = SemanticLookup.ResolveSymbol(compilation, enclosingDecl.Identifier) as StructSymbol;
        return structSymbol;
    }

    /// <summary>
    /// Resolves the receiver expression of an accessor to its <see cref="StructSymbol"/>
    /// type (user-defined G# struct or class).
    /// </summary>
    private static StructSymbol ResolveReceiverStructSymbol(SyntaxTree tree, Compilation compilation, ExpressionSyntax expression)
    {
        switch (expression)
        {
            case NameExpressionSyntax name:
                var symbol = SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken);
                return symbol switch
                {
                    VariableSymbol variable => variable.Type as StructSymbol,
                    StructSymbol structSym => structSym,
                    _ => null,
                };
            case CallExpressionSyntax call:
                var callSymbol = SemanticLookup.ResolveSymbol(compilation, call.Identifier);
                return callSymbol switch
                {
                    FunctionSymbol function => function.Type as StructSymbol,
                    StructSymbol structSym => structSym,
                    _ => null,
                };
            case AccessorExpressionSyntax nestedAccessor:
                // Chained access: resolve the intermediate member's type.
                if (!TryGetAccessorMemberName(nestedAccessor.RightPart, token: null, out var intermediateName))
                {
                    return null;
                }

                var outerStruct = ResolveReceiverStructSymbol(tree, compilation, nestedAccessor.LeftPart);
                if (outerStruct == null)
                {
                    return null;
                }

                var member = LookupMemberOnStruct(outerStruct, intermediateName);
                return member switch
                {
                    PropertySymbol property => property.Type as StructSymbol,
                    FieldSymbol field => field.Type as StructSymbol,
                    FunctionSymbol function => function.Type as StructSymbol,
                    _ => null,
                };
            default:
                return null;
        }
    }

    /// <summary>
    /// Looks up a member (property, field, event, or method) by name on a G# struct/class symbol,
    /// including inherited members from base classes.
    /// </summary>
    private static Symbol LookupMemberOnStruct(StructSymbol structSymbol, string memberName)
    {
        // Walk the type hierarchy (including base classes).
        for (var current = structSymbol; current != null; current = current.BaseClass)
        {
            // Properties (instance + static)
            var property = current.Properties.Concat(current.StaticProperties)
                .FirstOrDefault(p => p.Name == memberName);
            if (property != null)
            {
                return property;
            }

            // Fields (instance + static)
            var field = current.Fields.Concat(current.StaticFields)
                .FirstOrDefault(f => f.Name == memberName);
            if (field != null)
            {
                return field;
            }

            // Events (instance + static)
            var @event = current.Events.Concat(current.StaticEvents)
                .FirstOrDefault(e => e.Name == memberName);
            if (@event != null)
            {
                return @event;
            }

            // Methods (instance + static)
            var method = current.Methods.Concat(current.StaticMethods)
                .FirstOrDefault(m => m.Name == memberName);
            if (method != null)
            {
                return method;
            }
        }

        return null;
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

                // Rebuild the left prefix as a receiver expression for the nested right segment.
                var nestedReceiver = new AccessorExpressionSyntax(tree, receiver, nested.DotToken, nested.LeftPart);
                return TryResolveAccessorMemberContext(tree, nested.RightPart, nestedReceiver, token, out receiverExpression, out memberName);
            default:
                return false;
        }
    }

    private static bool TryGetAccessorMemberName(ExpressionSyntax expression, SyntaxToken token, out string memberName)
    {
        memberName = expression switch
        {
            NameExpressionSyntax name when token == null || MatchesToken(name.IdentifierToken, token) => name.IdentifierToken.Text,
            CallExpressionSyntax call when token == null || MatchesToken(call.Identifier, token) => call.Identifier.Text,
            _ => null,
        };

        return memberName != null;
    }

    private static bool MatchesToken(SyntaxToken candidate, SyntaxToken token)
    {
        return ReferenceEquals(candidate, token)
            || (candidate != null && token != null
                && candidate.Span.Start == token.Span.Start
                && candidate.Span.End == token.Span.End
                && string.Equals(candidate.Text, token.Text, StringComparison.Ordinal));
    }

    private static bool TryResolveClrReceiver(SyntaxTree tree, Compilation compilation, ExpressionSyntax expression, out ClrReceiver receiver)
    {
        switch (expression)
        {
            case NameExpressionSyntax name:
                if (TryResolveClrTypeFromSymbol(SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken), out var symbolType))
                {
                    receiver = new ClrReceiver(symbolType, StaticMembers: false);
                    return true;
                }

                var importedType = SemanticLookup.ResolveImportedClrType(tree, compilation, name.IdentifierToken.Text);
                if (importedType != null)
                {
                    receiver = new ClrReceiver(importedType, StaticMembers: true);
                    return true;
                }

                break;
            case CallExpressionSyntax call when TryResolveClrTypeFromSymbol(SemanticLookup.ResolveSymbol(compilation, call.Identifier), out var callType):
                receiver = new ClrReceiver(callType, StaticMembers: false);
                return true;
            case AccessorExpressionSyntax accessor when TryResolveClrMemberExpression(tree, compilation, accessor, out var memberType):
                receiver = new ClrReceiver(memberType, StaticMembers: false);
                return true;
        }

        receiver = default;
        return false;
    }

    private static bool TryResolveClrMemberExpression(SyntaxTree tree, Compilation compilation, AccessorExpressionSyntax accessor, out Type memberType)
    {
        memberType = null;
        if (!TryGetAccessorMemberName(accessor.RightPart, token: null, out var memberName))
        {
            return false;
        }

        if (!TryResolveClrReceiver(tree, compilation, accessor.LeftPart, out var receiver))
        {
            var gsharpReceiver = ResolveReceiverStructSymbol(tree, compilation, accessor.LeftPart);
            if (gsharpReceiver == null)
            {
                return false;
            }

            var gsharpMember = LookupMemberOnStruct(gsharpReceiver, memberName);
            return TryResolveClrTypeFromSymbol(gsharpMember, out memberType);
        }

        var flags = BindingFlags.Public | (receiver.StaticMembers ? BindingFlags.Static : BindingFlags.Instance);
        var property = ClrTypeUtilities.SafeGetProperty(receiver.Type, memberName, flags);
        if (property != null && property.GetIndexParameters().Length == 0)
        {
            memberType = property.PropertyType;
            return true;
        }

        var field = ClrTypeUtilities.SafeGetField(receiver.Type, memberName, flags);
        if (field != null)
        {
            memberType = field.FieldType;
            return true;
        }

        var @event = ClrTypeUtilities.SafeGetEvent(receiver.Type, memberName, flags);
        if (@event != null)
        {
            memberType = @event.EventHandlerType;
            return true;
        }

        var method = ClrTypeUtilities.SafeGetMethods(receiver.Type, flags)
            .FirstOrDefault(m => m.Name == memberName && !m.IsSpecialName);
        if (method == null)
        {
            return false;
        }

        memberType = method.ReturnType;
        return true;
    }

    private static bool TryResolveClrTypeFromSymbol(Symbol symbol, out Type clrType)
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

    private static string RenderHover(HoverModel model)
    {
        var sb = new StringBuilder();
        sb.Append("```gsharp\n").Append(model.Signature).Append("\n```");

        if (model.OverloadCount > 1)
        {
            var others = model.OverloadCount - 1;
            sb.Append("\n\n*(+ ").Append(others).Append(others == 1 ? " overload)*" : " overloads)*");
        }

        foreach (var section in model.Documentation)
        {
            sb.Append("\n\n");
            if (!string.IsNullOrEmpty(section.Heading))
            {
                sb.Append("**").Append(section.Heading).Append("**\n\n");
            }

            sb.Append(section.Body);
        }

        return sb.ToString();
    }

    private static int CountOverloads(Compilation compilation, FunctionSymbol function)
    {
        if (function.StaticOwnerType is StructSymbol staticOwner)
        {
            return staticOwner.StaticMethods.Count(m => m.Name == function.Name);
        }

        if (function.ReceiverType is StructSymbol owner)
        {
            return owner.Methods.Count(m => m.Name == function.Name);
        }

        return compilation.GlobalScope.Functions.Count(f => f.Name == function.Name);
    }

    // Surfaces ingested CLR documentation (ADR-0057 §6): imported symbols resolve their
    // companion .xml on demand via GetDocumentation(); authored G# docs (P2) flow through
    // the same path once attached. Symbols with no documentation render just the signature.
    private static IReadOnlyList<HoverDocSection> BuildDocumentation(Symbol symbol)
    {
        return HoverDocumentationRenderer.Render(symbol.GetDocumentation());
    }

    private static string FormatType(TypeSymbol type)
    {
        return type?.Name ?? "void";
    }

    private sealed record ClrReceiver(Type Type, bool StaticMembers);

    private sealed record HoverModel(string Signature, IReadOnlyList<HoverDocSection> Documentation, int OverloadCount);
}

/// <summary>A rendered hover documentation section: an optional bold heading and a Markdown body.</summary>
/// <param name="Heading">The section heading, or null for the lead (summary) section.</param>
/// <param name="Body">The Markdown body.</param>
internal sealed record HoverDocSection(string Heading, string Body);

public static class ReferencesComputer
{
    public static IReadOnlyList<Location> ComputeReferences(DocumentUri uri, DocumentContent content, Position position, bool includeDeclaration)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (target == null)
        {
            return Array.Empty<Location>();
        }

        return SemanticLookup.FindReferences(compilation, target)
            .Where(t => includeDeclaration || !IsDeclaration(compilation, t, target))
            .Select(t => new Location { Uri = GetDocumentUri(t, uri), Range = SemanticLookup.ToRange(t) })
            .ToList();
    }

    public static IReadOnlyList<SyntaxToken> ComputeReferenceTokens(DocumentContent content, Position position, bool includeDeclaration)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (target == null)
        {
            return Array.Empty<SyntaxToken>();
        }

        return SemanticLookup.FindReferences(compilation, target)
            .Where(t => includeDeclaration || !IsDeclaration(compilation, t, target))
            .ToList();
    }

    private static bool IsDeclaration(Compilation compilation, SyntaxToken token, Symbol target)
    {
        foreach (var declaration in SemanticLookup.FindReferences(compilation, target))
        {
            if (!ReferenceEquals(declaration, token) || declaration.Span.Start != token.Span.Start)
            {
                continue;
            }

            var containingTree = compilation.SyntaxTrees.FirstOrDefault(t => t.Text == token.SyntaxTree?.Text) ?? compilation.SyntaxTrees[0];
            var parentDeclaration = FindSmallestContainingDeclaration(containingTree.Root, token);
            return parentDeclaration switch
            {
                VariableDeclarationSyntax v => ReferenceEquals(v.Identifier, token),
                FunctionDeclarationSyntax f => ReferenceEquals(f.Identifier, token),
                ParameterSyntax p => ReferenceEquals(p.Identifier, token),
                StructDeclarationSyntax s => ReferenceEquals(s.Identifier, token),
                FieldDeclarationSyntax f => ReferenceEquals(f.Identifier, token),
                EnumDeclarationSyntax e => ReferenceEquals(e.Identifier, token),
                EnumMemberSyntax e => ReferenceEquals(e.Identifier, token),
                _ => false,
            };
        }

        return false;
    }

    private static DocumentUri GetDocumentUri(SyntaxToken token, DocumentUri fallback)
    {
        if (!string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName))
        {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName);
        }

        return fallback;
    }

    private static SyntaxNode FindSmallestContainingDeclaration(SyntaxNode node, SyntaxToken token)
    {
        SyntaxNode best = null;
        Visit(node);
        return best;

        void Visit(SyntaxNode current)
        {
            if (current.Span.Start <= token.Span.Start && token.Span.End <= current.Span.End)
            {
                if (current is VariableDeclarationSyntax or FunctionDeclarationSyntax or ParameterSyntax or StructDeclarationSyntax or FieldDeclarationSyntax or EnumDeclarationSyntax or EnumMemberSyntax)
                {
                    if (best == null || current.Span.Length < best.Span.Length)
                    {
                        best = current;
                    }
                }

                foreach (var child in current.GetChildren())
                {
                    Visit(child);
                }
            }
        }
    }
}

public static class RenameComputer
{
    public static WorkspaceEdit ComputeRename(DocumentUri uri, DocumentContent content, Position position, string newName)
    {
        if (!SemanticLookup.IsValidIdentifier(newName))
        {
            return null;
        }

        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (!SemanticLookup.CanRename(target))
        {
            return null;
        }

        var references = SemanticLookup.FindReferences(compilation, target).ToList();
        if (references.Count == 0)
        {
            return null;
        }

        // Group edits by document URI for cross-file rename support
        var editsByUri = new Dictionary<DocumentUri, List<TextEdit>>();
        foreach (var refToken in references)
        {
            var docUri = GetDocumentUri(refToken, uri);
            if (!editsByUri.TryGetValue(docUri, out var edits))
            {
                edits = new List<TextEdit>();
                editsByUri[docUri] = edits;
            }

            edits.Add(new TextEdit { Range = SemanticLookup.ToRange(refToken), NewText = newName });
        }

        return new WorkspaceEdit
        {
            Changes = editsByUri.ToDictionary(kv => kv.Key, kv => (IEnumerable<TextEdit>)kv.Value),
        };
    }

    private static DocumentUri GetDocumentUri(SyntaxToken token, DocumentUri fallback)
    {
        if (!string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName))
        {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName);
        }

        return fallback;
    }
}

public static class CodeActionComputer
{
    public static CommandOrCodeActionContainer ComputeCodeActions(DocumentUri uri, DocumentContent content, Range range)
    {
        var actions = new List<CommandOrCodeAction>();
        var sortImports = TryCreateSortImports(uri, content);
        if (sortImports != null)
        {
            actions.Add(new CommandOrCodeAction(sortImports));
        }

        return new CommandOrCodeActionContainer(actions);
    }

    private static CodeAction TryCreateSortImports(DocumentUri uri, DocumentContent content)
    {
        var imports = content.SyntaxTree.Root.Members.OfType<ImportSyntax>().ToList();
        if (imports.Count < 2)
        {
            return null;
        }

        var source = content.SyntaxTree.Text.ToString();
        var importTexts = imports.Select(i => source.Substring(i.Span.Start, i.Span.Length).TrimEnd()).ToList();
        var sorted = importTexts.OrderBy(t => t, StringComparer.Ordinal).ToList();
        if (importTexts.SequenceEqual(sorted))
        {
            return null;
        }

        var start = imports.First().Span.Start;
        var end = imports.Last().Span.End;
        while (end < source.Length && (source[end] == '\r' || source[end] == '\n'))
        {
            end++;
            if (end <= source.Length && source[end - 1] == '\r' && end < source.Length && source[end] == '\n')
            {
                end++;
            }

            break;
        }

        var newText = string.Join(Environment.NewLine, sorted) + Environment.NewLine;
        return new CodeAction
        {
            Title = "Sort imports",
            Kind = CodeActionKind.RefactorRewrite,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>>
                {
                    [uri] = new[]
                    {
                        new TextEdit
                        {
                            Range = SemanticLookup.ToRange(content.SyntaxTree.Text, TextSpan.FromBounds(start, end)),
                            NewText = newText,
                        },
                    },
                },
            },
        };
    }
}

public static class DefinitionComputer
{
    public static Location ComputeDefinition(DocumentUri uri, DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        var workspace = content.Workspace;

        // Imported symbols (cross-assembly): try sibling-G#-project source walk
        // first, then portable-PDB navigation. See CrossAssemblyDefinitionResolver.
        if (TryResolveImportedSymbol(symbol, workspace, out var crossLocation))
        {
            return crossLocation;
        }

        if (symbol != null)
        {
            var declarationToken = FindDeclarationToken(compilation, symbol);
            if (declarationToken != null)
            {
                var targetUri = GetDocumentUri(declarationToken, uri);
                return new Location { Uri = targetUri, Range = SemanticLookup.ToRange(declarationToken) };
            }
        }

        // Fallback: the token is on a CLR type name (e.g. `Console`) or a
        // member access RHS (e.g. `WriteLine` in `Console.WriteLine`) that did
        // not resolve to a G# symbol. Walk the import / member-access context
        // the same way HoverComputer does and map the result to a Location via
        // CrossAssemblyDefinitionResolver.
        if (token != null && token.Kind == SyntaxKind.IdentifierToken)
        {
            if (ImportedClrMemberResolver.TryResolveClrType(content.SyntaxTree, compilation, token, out var clrType)
                && CrossAssemblyDefinitionResolver.TryResolveType(workspace, clrType, out var typeLocation))
            {
                return typeLocation;
            }

            if (ImportedClrMemberResolver.TryResolveClrMember(content.SyntaxTree, compilation, token, out var clrMember)
                && TryResolveClrMember(workspace, clrMember, out var memberLocation))
            {
                return memberLocation;
            }
        }

        return null;
    }

    private static bool TryResolveImportedSymbol(Symbol symbol, WorkspaceState workspace, out Location location)
    {
        location = null;
        switch (symbol)
        {
            case ImportedClassSymbol importedClass:
                return CrossAssemblyDefinitionResolver.TryResolveType(workspace, importedClass.ClassType, out location);
            case ImportedTypeSymbol importedType:
                return CrossAssemblyDefinitionResolver.TryResolveType(workspace, importedType.Type, out location);
            case ImportedFunctionSymbol importedFunction:
                return CrossAssemblyDefinitionResolver.TryResolveMethod(workspace, importedFunction.Method, out location);
            default:
                return false;
        }
    }

    private static bool TryResolveClrMember(WorkspaceState workspace, MemberInfo member, out Location location)
    {
        location = null;
        switch (member)
        {
            case MethodInfo method:
                return CrossAssemblyDefinitionResolver.TryResolveMethod(workspace, method, out location);
            case PropertyInfo property:
                return CrossAssemblyDefinitionResolver.TryResolveProperty(workspace, property, out location);
            case FieldInfo field:
                return CrossAssemblyDefinitionResolver.TryResolveField(workspace, field, out location);
            case EventInfo @event:
                return CrossAssemblyDefinitionResolver.TryResolveEvent(workspace, @event, out location);
            default:
                return false;
        }
    }

    private static DocumentUri GetDocumentUri(SyntaxToken token, DocumentUri fallback)
    {
        if (!string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName))
        {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName);
        }

        return fallback;
    }

    private static SyntaxToken FindDeclarationToken(Compilation compilation, Symbol symbol)
    {
        return symbol switch
        {
            FunctionSymbol f when f.Declaration != null => f.Declaration.Identifier,
            StructSymbol s when s.Declaration != null => s.Declaration.Identifier,
            EnumSymbol e when e.Declaration != null => e.Declaration.Identifier,
            EnumMemberSymbol m => FindEnumMemberToken(m),
            FieldSymbol field => FindFieldToken(compilation, field),
            VariableSymbol variable => FindVariableToken(compilation, variable),
            _ => null,
        };
    }

    private static SyntaxToken FindEnumMemberToken(EnumMemberSymbol member)
    {
        if (member.EnumType?.Declaration == null)
        {
            return null;
        }

        return member.EnumType.Declaration.Members
            .Select(m => m.Identifier)
            .FirstOrDefault(id => id.Text == member.Name);
    }

    private static SyntaxToken FindFieldToken(Compilation compilation, FieldSymbol field)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var structDecl in FindNodes<StructDeclarationSyntax>(tree.Root))
            {
                foreach (var fieldDecl in structDecl.Fields)
                {
                    if (fieldDecl.Identifier.Text == field.Name)
                    {
                        return fieldDecl.Identifier;
                    }
                }
            }
        }

        return null;
    }

    private static SyntaxToken FindVariableToken(Compilation compilation, VariableSymbol variable)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var varDecl in FindNodes<VariableDeclarationSyntax>(tree.Root))
            {
                if (varDecl.Identifier.Text == variable.Name)
                {
                    return varDecl.Identifier;
                }
            }

            foreach (var funcDecl in FindNodes<FunctionDeclarationSyntax>(tree.Root))
            {
                foreach (var param in funcDecl.Parameters)
                {
                    if (param.Identifier.Text == variable.Name)
                    {
                        return param.Identifier;
                    }
                }
            }
        }

        return null;
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

public static class DocumentSymbolComputer
{
    public static IReadOnlyList<SymbolInformationOrDocumentSymbol> ComputeDocumentSymbols(DocumentContent content)
    {
        var result = new List<SymbolInformationOrDocumentSymbol>();
        var text = content.SyntaxTree.Text;

        foreach (var member in content.SyntaxTree.Root.Members)
        {
            switch (member)
            {
                case FunctionDeclarationSyntax func:
                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = func.Identifier.Text,
                        Kind = LspSymbolKind.Function,
                        Range = SemanticLookup.ToRange(text, func.Span),
                        SelectionRange = SemanticLookup.ToRange(func.Identifier),
                    }));
                    break;
                case GlobalStatementSyntax { Statement: VariableDeclarationSyntax variable }:
                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = variable.Identifier.Text,
                        Kind = LspSymbolKind.Variable,
                        Range = SemanticLookup.ToRange(text, variable.Span),
                        SelectionRange = SemanticLookup.ToRange(variable.Identifier),
                    }));
                    break;
                case StructDeclarationSyntax structDecl:
                    var children = new List<DocumentSymbol>();
                    foreach (var field in structDecl.Fields)
                    {
                        children.Add(new DocumentSymbol
                        {
                            Name = field.Identifier.Text,
                            Kind = LspSymbolKind.Field,
                            Range = SemanticLookup.ToRange(text, field.Span),
                            SelectionRange = SemanticLookup.ToRange(field.Identifier),
                        });
                    }

                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = structDecl.Identifier.Text,
                        Kind = LspSymbolKind.Struct,
                        Range = SemanticLookup.ToRange(text, structDecl.Span),
                        SelectionRange = SemanticLookup.ToRange(structDecl.Identifier),
                        Children = children,
                    }));
                    break;
                case EnumDeclarationSyntax enumDecl:
                    var enumChildren = new List<DocumentSymbol>();
                    foreach (var enumMember in enumDecl.Members)
                    {
                        enumChildren.Add(new DocumentSymbol
                        {
                            Name = enumMember.Identifier.Text,
                            Kind = LspSymbolKind.EnumMember,
                            Range = SemanticLookup.ToRange(text, enumMember.Span),
                            SelectionRange = SemanticLookup.ToRange(enumMember.Identifier),
                        });
                    }

                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = enumDecl.Identifier.Text,
                        Kind = LspSymbolKind.Enum,
                        Range = SemanticLookup.ToRange(text, enumDecl.Span),
                        SelectionRange = SemanticLookup.ToRange(enumDecl.Identifier),
                        Children = enumChildren,
                    }));
                    break;
            }
        }

        return result;
    }
}

public static class SignatureHelpComputer
{
    public static SignatureHelp ComputeSignatureHelp(DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);

        // Walk backwards from cursor to find the function name token before the opening paren
        var source = content.SyntaxTree.Text.ToString();
        var parenDepth = 0;
        var activeParameter = 0;
        int? funcNameEnd = null;

        for (var i = offset - 1; i >= 0; i--)
        {
            var c = source[i];
            if (c == ')')
            {
                parenDepth++;
            }
            else if (c == '(')
            {
                if (parenDepth > 0)
                {
                    parenDepth--;
                }
                else
                {
                    funcNameEnd = i;
                    break;
                }
            }
            else if (c == ',' && parenDepth == 0)
            {
                activeParameter++;
            }
        }

        if (funcNameEnd == null)
        {
            return null;
        }

        // Find the identifier token just before the paren
        var funcToken = SemanticLookup.FindTokenAt(content.SyntaxTree, funcNameEnd.Value - 1);
        var symbol = SemanticLookup.ResolveSymbol(compilation, funcToken);
        if (symbol is not FunctionSymbol function)
        {
            return null;
        }

        var parameters = function.Parameters
            .Select(p => new ParameterInformation
            {
                Label = $"{p.Name} {FormatType(p.Type)}",
            })
            .ToList();

        var signature = new SignatureInformation
        {
            Label = HoverComputer.FormatSymbol(function),
            Parameters = parameters,
        };

        return new SignatureHelp
        {
            Signatures = new[] { signature },
            ActiveSignature = 0,
            ActiveParameter = Math.Min(activeParameter, Math.Max(0, parameters.Count - 1)),
        };
    }

    private static string FormatType(TypeSymbol type)
    {
        return type?.Name ?? "void";
    }
}

public static class CompletionComputer
{
    public static IReadOnlyList<CompletionItem> ComputeCompletions(DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);

        // Member-access context (`receiver.<caret>`): offer the receiver's members
        // instead of the global keyword/symbol list. Returns null only when the
        // caret is not positioned after a member-access dot.
        var memberItems = TryComputeMemberCompletions(content, compilation, offset);
        if (memberItems != null)
        {
            return memberItems;
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // Add keywords
        foreach (var keyword in GetKeywords())
        {
            if (seen.Add(keyword))
            {
                items.Add(new CompletionItem
                {
                    Label = keyword,
                    Kind = CompletionItemKind.Keyword,
                });
            }
        }

        // Add global symbols (functions, variables, types)
        foreach (var function in compilation.GlobalScope.Functions)
        {
            if (seen.Add(function.Name))
            {
                items.Add(new CompletionItem
                {
                    Label = function.Name,
                    Kind = CompletionItemKind.Function,
                    Detail = HoverComputer.FormatSymbol(function),
                });
            }
        }

        foreach (var variable in compilation.GlobalScope.Variables)
        {
            if (seen.Add(variable.Name))
            {
                items.Add(new CompletionItem
                {
                    Label = variable.Name,
                    Kind = CompletionItemKind.Variable,
                    Detail = HoverComputer.FormatSymbol(variable),
                });
            }
        }

        foreach (var structSymbol in compilation.GlobalScope.Structs)
        {
            if (seen.Add(structSymbol.Name))
            {
                items.Add(new CompletionItem
                {
                    Label = structSymbol.Name,
                    Kind = CompletionItemKind.Struct,
                    Detail = HoverComputer.FormatSymbol(structSymbol),
                });
            }
        }

        foreach (var pair in compilation.GlobalScope.TypeAliases)
        {
            if (seen.Add(pair.Key))
            {
                items.Add(new CompletionItem
                {
                    Label = pair.Key,
                    Kind = pair.Value is EnumSymbol ? CompletionItemKind.Enum : CompletionItemKind.Class,
                    Detail = HoverComputer.FormatSymbol(pair.Value),
                });
            }
        }

        // Add local symbols from the containing function
        var containingFunction = FindContainingFunction(content.SyntaxTree, offset);
        if (containingFunction != null)
        {
            foreach (var param in containingFunction.Parameters)
            {
                if (seen.Add(param.Identifier.Text))
                {
                    items.Add(new CompletionItem
                    {
                        Label = param.Identifier.Text,
                        Kind = CompletionItemKind.Variable,
                    });
                }
            }
        }

        // Add primitive types
        foreach (var type in new[] { "bool", "int32", "string", "void" })
        {
            if (seen.Add(type))
            {
                items.Add(new CompletionItem
                {
                    Label = type,
                    Kind = CompletionItemKind.TypeParameter,
                });
            }
        }

        return items;
    }

    private static FunctionDeclarationSyntax FindContainingFunction(SyntaxTree tree, int offset)
    {
        FunctionDeclarationSyntax best = null;
        foreach (var func in tree.Root.Members.OfType<FunctionDeclarationSyntax>())
        {
            if (func.Span.Start <= offset && offset <= func.Span.End)
            {
                if (best == null || func.Span.Length < best.Span.Length)
                {
                    best = func;
                }
            }
        }

        return best;
    }

    private static IReadOnlyList<CompletionItem> TryComputeMemberCompletions(DocumentContent content, Compilation compilation, int offset)
    {
        var accessor = FindReceiverAccessor(content.SyntaxTree.Root, offset);
        if (accessor == null)
        {
            // Not a member-access context — caller falls back to the global list.
            return null;
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        var chainRoot = FindChainRoot(content.SyntaxTree.Root, accessor);
        var isSimpleNameReceiver = ReferenceEquals(chainRoot, accessor)
            && accessor.LeftPart is NameExpressionSyntax simpleName
            && !simpleName.IdentifierToken.IsMissing;

        if (!isSimpleNameReceiver)
        {
            // Complex or chained receivers — `(a + b).`, `foo().`, `arr[0].`,
            // `a.b.`, etc. Reconstruct the full receiver expression (chains parse
            // right-nested, so the trailing accessor's LeftPart is only the last
            // segment) and speculatively bind it to infer the member type.
            var receiverExpression = ReconstructReceiverExpression(content, chainRoot, accessor);
            if (receiverExpression != null)
            {
                var (function, locals) = SemanticLookup.GetExpressionBindingContext(compilation, offset);
                var receiverType = GSharp.Core.CodeAnalysis.Binding.Binder.TryInferExpressionType(
                    compilation.GlobalScope,
                    compilation.References,
                    function,
                    locals,
                    receiverExpression);
                if (receiverType != null)
                {
                    AddInstanceTypeMembers(items, seen, receiverType);
                }
            }

            // Whether or not inference succeeded, suppress the global keyword list
            // since the caret sits in a member-access position.
            return items;
        }

        var leftName = (NameExpressionSyntax)accessor.LeftPart;
        var receiver = SemanticLookup.ResolveSymbol(compilation, leftName.IdentifierToken);
        switch (receiver)
        {
            case VariableSymbol variable:
                AddInstanceTypeMembers(items, seen, variable.Type);
                break;
            case EnumSymbol enumSymbol:
                AddEnumMembers(items, seen, enumSymbol);
                break;
            case StructSymbol structType:
                AddStructStaticMembers(items, seen, structType);
                break;
            case TypeSymbol typeSymbol:
                AddClrMembers(items, seen, typeSymbol.ClrType, staticMembers: true);
                break;
            case null:
                // An imported CLR type referenced by name (e.g. `Console`).
                AddClrMembers(items, seen, SemanticLookup.ResolveImportedClrType(content.SyntaxTree, compilation, leftName.IdentifierToken.Text), staticMembers: true);
                break;
        }

        return items;
    }

    /// <summary>
    /// Finds the outermost postfix expression (member access or index) that ends
    /// at the same position as <paramref name="accessor"/> — i.e. the root of the
    /// receiver chain. Member-access chains parse right-nested, so the trailing
    /// dot's accessor covers only the final segment; the chain root spans the whole
    /// receiver.
    /// </summary>
    private static ExpressionSyntax FindChainRoot(SyntaxNode root, AccessorExpressionSyntax accessor)
    {
        ExpressionSyntax best = accessor;
        foreach (var node in EnumerateNodes(root))
        {
            if (node is not (AccessorExpressionSyntax or IndexExpressionSyntax))
            {
                continue;
            }

            var candidate = (ExpressionSyntax)node;
            if (candidate.Span.End == accessor.Span.End
                && candidate.Span.Start <= best.Span.Start
                && candidate.Span.Start <= accessor.Span.Start)
            {
                best = candidate;
            }
        }

        return best;
    }

    /// <summary>
    /// Reconstructs the receiver expression to the left of the trailing dot. When
    /// the receiver is the accessor's own (non-chained) left part it is returned
    /// directly; for chained receivers the source text between the chain root and
    /// the trailing dot is re-parsed into a standalone expression.
    /// </summary>
    private static ExpressionSyntax ReconstructReceiverExpression(DocumentContent content, ExpressionSyntax chainRoot, AccessorExpressionSyntax accessor)
    {
        if (ReferenceEquals(chainRoot, accessor))
        {
            return accessor.LeftPart;
        }

        var dotStart = accessor.DotToken.Span.Start;
        var start = chainRoot.Span.Start;
        if (dotStart <= start)
        {
            return null;
        }

        var text = content.SyntaxTree.Text.ToString(start, dotStart - start);
        var tree = SyntaxTree.Parse(text);
        return EnumerateNodes(tree.Root).OfType<ExpressionSyntax>().FirstOrDefault();
    }

    private static IEnumerable<SyntaxNode> EnumerateNodes(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            if (child is SyntaxToken)
            {
                continue;
            }

            foreach (var descendant in EnumerateNodes(child))
            {
                yield return descendant;
            }
        }
    }

    private static AccessorExpressionSyntax FindReceiverAccessor(SyntaxNode node, int offset)
    {
        AccessorExpressionSyntax best = null;
        foreach (var accessor in FindAccessors(node))
        {
            var dot = accessor.DotToken;
            if (dot == null || dot.IsMissing)
            {
                continue;
            }

            // Caret must sit after the dot and within the accessor expression.
            if (dot.Span.End <= offset && offset <= accessor.Span.End)
            {
                if (best == null || dot.Span.End > best.DotToken.Span.End)
                {
                    best = accessor;
                }
            }
        }

        return best;
    }

    private static IEnumerable<AccessorExpressionSyntax> FindAccessors(SyntaxNode node)
    {
        if (node is AccessorExpressionSyntax accessor)
        {
            yield return accessor;
        }

        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in FindAccessors(child))
            {
                yield return descendant;
            }
        }
    }

    private static void AddInstanceTypeMembers(List<CompletionItem> items, HashSet<string> seen, TypeSymbol type)
    {
        if (type is StructSymbol structType)
        {
            AddStructInstanceMembers(items, seen, structType);
            return;
        }

        AddClrMembers(items, seen, type?.ClrType, staticMembers: false);
    }

    private static void AddStructInstanceMembers(List<CompletionItem> items, HashSet<string> seen, StructSymbol structType)
    {
        for (var current = structType; current != null; current = current.BaseClass)
        {
            foreach (var field in current.Fields)
            {
                AddItem(items, seen, field.Name, CompletionItemKind.Field, HoverComputer.FormatSymbol(field));
            }

            foreach (var property in current.Properties)
            {
                AddItem(items, seen, property.Name, CompletionItemKind.Property, $"{property.Name}: {property.Type?.Name}");
            }

            foreach (var method in current.Methods)
            {
                AddItem(items, seen, method.Name, CompletionItemKind.Method, HoverComputer.FormatSymbol(method));
            }
        }
    }

    private static void AddStructStaticMembers(List<CompletionItem> items, HashSet<string> seen, StructSymbol structType)
    {
        foreach (var field in structType.StaticFields)
        {
            AddItem(items, seen, field.Name, CompletionItemKind.Field, HoverComputer.FormatSymbol(field));
        }

        foreach (var property in structType.StaticProperties)
        {
            AddItem(items, seen, property.Name, CompletionItemKind.Property, $"{property.Name}: {property.Type?.Name}");
        }

        foreach (var method in structType.StaticMethods)
        {
            AddItem(items, seen, method.Name, CompletionItemKind.Method, HoverComputer.FormatSymbol(method));
        }
    }

    private static void AddEnumMembers(List<CompletionItem> items, HashSet<string> seen, EnumSymbol enumSymbol)
    {
        foreach (var member in enumSymbol.Members)
        {
            AddItem(items, seen, member.Name, CompletionItemKind.EnumMember, $"{enumSymbol.Name}.{member.Name}");
        }
    }

    private static void AddClrMembers(List<CompletionItem> items, HashSet<string> seen, Type clrType, bool staticMembers)
    {
        if (clrType == null)
        {
            return;
        }

        var flags = BindingFlags.Public | (staticMembers ? BindingFlags.Static : BindingFlags.Instance);

        foreach (var property in ClrTypeUtilities.SafeGetProperties(clrType, flags))
        {
            if (property.GetIndexParameters().Length == 0)
            {
                AddItem(items, seen, property.Name, CompletionItemKind.Property, $"{property.Name}: {property.PropertyType.Name}");
            }
        }

        foreach (var field in ClrTypeUtilities.SafeGetFields(clrType, flags))
        {
            var kind = field.IsLiteral ? CompletionItemKind.Constant : CompletionItemKind.Field;
            AddItem(items, seen, field.Name, kind, $"{field.Name}: {field.FieldType.Name}");
        }

        foreach (var method in ClrTypeUtilities.SafeGetMethods(clrType, flags))
        {
            if (method.IsSpecialName)
            {
                continue;
            }

            AddItem(items, seen, method.Name, CompletionItemKind.Method, $"{method.Name}(...): {method.ReturnType.Name}");
        }

        foreach (var evt in ClrTypeUtilities.SafeGetEvents(clrType, flags))
        {
            AddItem(items, seen, evt.Name, CompletionItemKind.Event, evt.Name);
        }
    }

    private static void AddItem(List<CompletionItem> items, HashSet<string> seen, string label, CompletionItemKind kind, string detail)
    {
        if (string.IsNullOrEmpty(label) || !seen.Add(label))
        {
            return;
        }

        items.Add(new CompletionItem { Label = label, Kind = kind, Detail = detail });
    }

    private static IEnumerable<string> GetKeywords()
    {
        yield return "let";
        yield return "func";
        yield return "if";
        yield return "else";
        yield return "while";
        yield return "for";
        yield return "in";
        yield return "return";
        yield return "break";
        yield return "continue";
        yield return "true";
        yield return "false";
        yield return "type";
        yield return "struct";
        yield return "class";
        yield return "enum";
        yield return "import";
        yield return "switch";
        yield return "case";
        yield return "default";
        yield return "go";
        yield return "select";
        yield return "try";
        yield return "catch";
        yield return "throw";
        yield return "async";
        yield return "await";
    }
}
