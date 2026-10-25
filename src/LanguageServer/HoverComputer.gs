// <copyright file="LspFeatureComputers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Text
import System.Threading
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind
import Range = GSharp.LanguageServer.Protocol.Range
import GSharp.Core.CodeAnalysis.Documentation
import System.Globalization

shared class HoverComputer {
    private data class ClrReceiver(Type Type, StaticMembers bool) : IEquatable[ClrReceiver] { }

    private data class HoverModel(
        Signature string,
        Documentation IReadOnlyList[HoverDocSection],
        OverloadCount int32
    ) : IEquatable[HoverModel] { }

    func ComputeHover(
        content DocumentContent,
        position Position,
        ct CancellationToken = default(CancellationToken)
    ) Hover? {
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        if token == nil {
            return nil
        }
        // Issue #713: when hovering a token inside an `async func(...)` (ADR-0043) or
        // `async sequence[T]` (ADR-0042) type clause, surface the ADR-rooted prose
        // before falling through to symbol/identifier resolution. The two type-clause
        // spellings have no resolved symbol of their own — the binder collapses them
        // onto FunctionTypeSymbol / AsyncSequenceTypeSymbol — so without this carve-out
        // the user would get nothing.
        let asyncHover Hover? = TryComputeAsyncTypeClauseHover(content.SyntaxTree, offset, token)
        if asyncHover != nil {
            return asyncHover
        }
        var symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token, ct)
        // When the token isn't directly in the semantic model (e.g. member access
        // on a user-defined type like person.Name), try resolving through the
        // accessor expression's receiver type.
        if symbol == nil {
            symbol = TryResolveGSharpMember(content.SyntaxTree, compilation, token)
        }
        var model HoverModel? = if symbol != nil {
            BuildHoverModel(symbol, compilation)
        } else {
            BuildImportedClrModel(content.SyntaxTree, compilation, token)
        }
        // Literal tokens (numbers, strings, booleans) show their inferred type.
        if model == nil {
            model = BuildLiteralModel(token)
        }
        if model == nil {
            return nil
        }
        return Hover{
            Contents: MarkedStringsOrMarkupContent(MarkupContent{Kind: MarkupKind.Markdown, Value: RenderHover(model)}),
            Range: SemanticLookup.ToRange(token)
        }
    }

    /// Renders a symbol's compact signature label for signature help and completion
    /// detail. Hover uses the richer (cref:SymbolDisplayFormat.Hover) form via
    /// (cref:ComputeHover).
    /// @param symbol The symbol to render.
    /// @returns The compact signature label.
    func FormatSymbol(symbol Symbol) string {
        return SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature)
    }

    /// Renders a symbol's compact signature label, using [`compilation`](paramref)
    /// to recover a variable's exact declaring keyword.
    /// @param symbol The symbol to render.
    /// @param compilation The compilation providing declaration syntax.
    /// @returns The compact signature label.
    func FormatSymbol(symbol Symbol, compilation Compilation) string {
        return SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature, compilation)
    }

    private func TryComputeAsyncTypeClauseHover(tree SyntaxTree, offset int32, token SyntaxToken?) Hover? {
        if token == nil || token.IsMissing {
            return nil
        }
        // Only trigger on the tokens that uniquely identify the two async-type
        // spellings — anything else (identifier, operator, punctuation) falls back to
        // the regular symbol-resolution path. The arrow form (ADR-0075) is keyed off
        // the `->` token; the legacy `func` keyword still triggers during the
        // deprecation window so old sources continue to surface the same docs.
        if token.Kind != SyntaxKind.AsyncKeyword &&
            token.Kind != SyntaxKind.SequenceKeyword &&
            token.Kind != SyntaxKind.FuncKeyword &&
            token.Kind != SyntaxKind.RightArrowToken {
            return nil
        }
        let enclosing TypeClauseSyntax? = TypeClauseCompletions.FindEnclosingTypeClause(tree.Root, offset)
        if enclosing == nil {
            return nil
        }
        var body string
        if enclosing.IsAsyncFunction &&
            (
            token.Kind == SyntaxKind.AsyncKeyword ||
                token.Kind == SyntaxKind.FuncKeyword ||
                token.Kind == SyntaxKind.RightArrowToken
        ) {
            body = ("```" + `gsharp
async (...) -> R
` + "```" + `

`) + TypeClauseCompletions.AsyncFuncDocumentation
        } else if enclosing.IsAsyncSequence &&
            (token.Kind == SyntaxKind.AsyncKeyword || token.Kind == SyntaxKind.SequenceKeyword) {
            body = ("```" + `gsharp
async sequence[T]
` + "```" + `

`) + TypeClauseCompletions.AsyncSequenceDocumentation
        } else {
            return nil
        }
        return Hover{
            Contents: MarkedStringsOrMarkupContent(MarkupContent{Kind: MarkupKind.Markdown, Value: body}),
            Range: SemanticLookup.ToRange(token)
        }
    }

    private func BuildHoverModel(symbol Symbol, compilation Compilation) HoverModel {
        let signature = SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Hover, compilation)
        let overloadCount = if symbol is FunctionSymbol function {
            CountOverloads(compilation, function)
        } else {
            1
        }
        return HoverModel(signature, BuildDocumentation(symbol), overloadCount)
    }

    private func BuildImportedClrModel(tree SyntaxTree, compilation Compilation, token SyntaxToken?) HoverModel? {
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return nil
        }
        // Issue #4989: the imported member the binder bound the token to wins
        // over the name-and-arity scan and the reflection lookups below, which
        // can report a same-named member of another type.
        let boundModel HoverModel? = switch BoundSemantics.GetImportedMember(compilation, token) {
            case boundMethod is MethodInfo: HoverModel(
                SymbolDisplay.ToDisplayString(boundMethod, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(boundMethod)),
                SemanticLookup.CountSameNamedMethods(boundMethod)
            )
            case boundProperty is PropertyInfo: HoverModel(
                SymbolDisplay.ToDisplayString(boundProperty, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(boundProperty)),
                OverloadCount: 1
            )
            case boundField is FieldInfo: HoverModel(
                SymbolDisplay.ToDisplayString(boundField, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(boundField)),
                OverloadCount: 1
            )
            default: default(HoverModel?)
        }
        if boundModel != nil {
            return boundModel
        }
        // Issue #891: when the token is the identifier of an invoked call (e.g.
        // the `Single` in `report.Checks.Single(...)`), resolve the actual
        // method the call bound to BEFORE attempting type-name resolution.
        // Otherwise `ResolveImportedClrType("Single")` matches the unrelated
        // type `System.Single` (float32) and hover shows the wrong content.
        // This also handles generic extension methods, which plain reflection
        // on the receiver type would miss.
        let invokedCall CallExpressionSyntax? = FindNodes[CallExpressionSyntax](tree.Root).FirstOrDefault(
            (call CallExpressionSyntax) -> MatchesToken(call.Identifier, token)
        )
        if invokedCall != nil {
            // Disambiguate the program-wide same-name scan by the hovered call's
            // receiver syntax: a value receiver (`x.M(...)`) can only bind to an
            // instance/extension method, a type-name receiver (`T.M(...)`) only to
            // a plain static method (issue #906).
            let gate = ClassifyCallReceiver(tree, compilation, token, out var receiverClrType)
            if SemanticLookup.TryResolveInvokedImportedMethod(
                compilation,
                token.Text,
                invokedCall.Arguments.Count,
                gate,
                receiverClrType,
                out var invokedMethod,
                out var invokedOverloadCount
            ) &&
                invokedMethod != nil {
                return HoverModel(
                    SymbolDisplay.ToDisplayString(invokedMethod, SymbolDisplayFormat.Hover),
                    HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(invokedMethod)),
                    invokedOverloadCount
                )
            }
        }
        let clrType Type? = SemanticLookup.ResolveImportedClrType(
            tree,
            compilation,
            token.Text,
            includeAttributeSuffixFallback: IsAnnotationNameToken(tree.Root, token)
        )
        if clrType != nil {
            let signature = SymbolDisplay.ToDisplayString(clrType, SymbolDisplayFormat.Hover)
            let documentation = HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(clrType))
            return HoverModel(signature, documentation, OverloadCount: 1)
        }
        if !TryResolveClrMember(tree, compilation, token, out var member, out var overloadCount) {
            return nil
        }
        return switch member {
            case property is PropertyInfo: HoverModel(
                SymbolDisplay.ToDisplayString(property, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(property)),
                OverloadCount: 1
            )
            case field is FieldInfo: HoverModel(
                SymbolDisplay.ToDisplayString(field, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(field)),
                OverloadCount: 1
            )
            case event is EventInfo: HoverModel(
                SymbolDisplay.ToDisplayString(event, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(event)),
                OverloadCount: 1
            )
            case method is MethodInfo: HoverModel(
                SymbolDisplay.ToDisplayString(method, SymbolDisplayFormat.Hover),
                HoverDocumentationRenderer.Render(AssemblyDocumentationProvider.Resolve(method)),
                overloadCount
            )
            default: default(HoverModel?)
        }
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

    private func BuildLiteralModel(token SyntaxToken?) HoverModel? {
        if token == nil {
            return nil
        }
        let typeName string? = switch token.Kind {
            case SyntaxKind.NumberToken: GetNumericTypeName(token.Value)
            case SyntaxKind.StringToken: "string"
            case SyntaxKind.ByteStringToken: "bytestring"
            case SyntaxKind.InterpolatedStringToken: "string"
            case SyntaxKind.TrueKeyword: "bool"
            case SyntaxKind.FalseKeyword: "bool"
            default: default(string?)
        }
        if typeName == nil {
            return nil
        }
        let signature = "($typeName) ${token.Text}"
        return HoverModel(signature, Array.Empty[HoverDocSection](), OverloadCount: 1)
    }

    private func GetNumericTypeName(value object?) string {
        return switch value {
            case _ is int32: "int32"
            case _ is uint32: "uint32"
            case _ is int64: "int64"
            case _ is uint64: "uint64"
            case _ is float32: "float32"
            case _ is float64: "float64"
            case _ is decimal: "decimal"
            default: "int32"
        }
    }

    private func TryResolveClrMember(
        tree SyntaxTree,
        compilation Compilation,
        token SyntaxToken,
        out member MemberInfo?,
        out overloadCount int32
    ) bool {
        member = nil
        overloadCount = 0
        for context in FindAccessorMemberContexts(tree, token).Concat(
            FindObjectInitializerMemberContexts(tree, token)
        ) {
            var receiver ClrReceiver?
            if token.Parent?.Parent is MemberCollectionElementSyntax && InferInitializerReceiverType(
                tree,
                compilation,
                context.ReceiverExpression
            )?.ClrType is {} clrType {
                receiver = ClrReceiver(clrType, StaticMembers: false)
            } else if !TryResolveClrReceiver(tree, compilation, context.ReceiverExpression, out receiver) ||
                receiver == nil {
                continue
            }
            let flags = BindingFlags.Public | (
                if receiver.StaticMembers {
                    BindingFlags.Static
                } else {
                    BindingFlags.Instance
                }
            )
            let property PropertyInfo? = ClrTypeUtilities.SafeGetProperty(receiver.Type, context.MemberName, flags)
            if property != nil && property.GetIndexParameters().Length == 0 {
                member = property
                overloadCount = 1
                return true
            }
            let field FieldInfo? = ClrTypeUtilities.SafeGetField(receiver.Type, context.MemberName, flags)
            if field != nil {
                member = field
                overloadCount = 1
                return true
            }
            let event EventInfo? = ClrTypeUtilities.SafeGetEvent(receiver.Type, context.MemberName, flags)
            if event != nil {
                member = event
                overloadCount = 1
                return true
            }
            let methods = ClrTypeUtilities
                .SafeGetMethods(receiver.Type, flags)
                .Where((m MethodInfo) -> m.Name == context.MemberName && !m.IsSpecialName)
                .ToArray()
            if methods.Length == 0 {
                continue
            }
            member = methods[0]
            overloadCount = methods.Length
            return true
        }
        return false
    }

    private func InferInitializerReceiverType(
        tree SyntaxTree,
        compilation Compilation,
        target ExpressionSyntax
    ) TypeSymbol? {
        let (function, locals) = SemanticLookup.GetExpressionBindingContext(compilation, tree, target.Span.Start)
        return GSharp
            .Core
            .CodeAnalysis
            .Binding
            .Binder
            .TryInferExpressionType(
            compilation.GlobalScope,
            compilation.References ?? ReferenceResolver.Default(),
            function,
            locals,
            target
        )
    }

    /// Resolves a member access on a user-defined G# type (struct/class).
    /// For example, hovering over `Name` in `person.Name` where
    /// `person` is a G#-defined class resolves to the (cref:PropertySymbol),
    /// (cref:FieldSymbol), (cref:EventSymbol), or (cref:FunctionSymbol)
    /// declared on that type.
    private func TryResolveGSharpMember(tree SyntaxTree, compilation Compilation, token SyntaxToken?) Symbol? {
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return nil
        }
        // Case 1: member access expression (e.g. var x = person.Name), or an
        // object-initializer property name (e.g. Point() { X = 1 }) whose receiver
        // is the constructed G# struct/class type.
        for context in FindAccessorMemberContexts(tree, token).Concat(
            FindObjectInitializerMemberContexts(tree, token)
        ) {
            let receiverType = if token.Parent?.Parent is MemberCollectionElementSyntax {
                InferInitializerReceiverType(tree, compilation, context.ReceiverExpression)
            } else {
                (ResolveReceiverStructSymbol(tree, compilation, context.ReceiverExpression) as TypeSymbol?)
            }
            if receiverType is StructSymbol structSymbol {
                let member Symbol? = LookupMemberOnStruct(structSymbol, context.MemberName)
                if member != nil {
                    return member
                }
            } else if receiverType is InterfaceSymbol interfaceSymbol && TypeMemberModel.TryGetPropertyWithOwner(
                interfaceSymbol,
                context.MemberName,
                out var property,
                out _
            ) {
                return property
            }
        }
        // Case 2: field assignment expression (e.g. person.Age = 30)
        let fieldAssignment FieldAssignmentExpressionSyntax? = FindFieldAssignmentWithHoveredField(tree.Root, token)
        if fieldAssignment != nil {
            let receiverSymbol = SemanticLookup.ResolveSymbol(compilation, fieldAssignment.Receiver)
            let receiverStruct StructSymbol? = switch receiverSymbol {
                case variable is VariableSymbol: variable.Type as StructSymbol
                case structSym is StructSymbol: structSym
                default: default(StructSymbol?)
            }
            if receiverStruct != nil {
                return LookupMemberOnStruct(receiverStruct, fieldAssignment.FieldIdentifier.Text)
            }
        }
        // Case 3: implicit this — bare identifier inside a struct/class method body
        // that matches a member of the enclosing type (e.g. `Name` instead of `this.Name`).
        let enclosingStruct StructSymbol? = FindEnclosingStructSymbol(tree, compilation, token)
        if enclosingStruct != nil {
            let member Symbol? = LookupMemberOnStruct(enclosingStruct, token.Text)
            if member != nil {
                return member
            }
        }
        return nil
    }

    private func FindFieldAssignmentWithHoveredField(
        root SyntaxNode,
        token SyntaxToken
    ) FieldAssignmentExpressionSyntax? {
        return FindNodes[FieldAssignmentExpressionSyntax](root).Where(
            (f FieldAssignmentExpressionSyntax) -> MatchesToken(f.FieldIdentifier, token)
        )
            .FirstOrDefault()
    }

    /// Finds the (cref:StructSymbol) for the struct/class whose method body
    /// encloses [`token`](paramref), if any. Used for implicit-this resolution.
    private func FindEnclosingStructSymbol(tree SyntaxTree, compilation Compilation, token SyntaxToken) StructSymbol? {
        // Find the innermost StructDeclarationSyntax whose span contains the token.
        let enclosingDecl StructDeclarationSyntax? = FindNodes[StructDeclarationSyntax](tree.Root)
            .Where((s StructDeclarationSyntax) -> s.Span.Start <= token.Span.Start && token.Span.End <= s.Span.End)
            .OrderBy((s StructDeclarationSyntax) -> s.Span.Length)
            .FirstOrDefault()
        if enclosingDecl == nil {
            return nil
        }
        // Ensure the token is inside a method body, not in the struct's own declarations.
        let insideMethod = enclosingDecl.Methods.Any(
            (m FunctionDeclarationSyntax) -> m.Body != nil &&
                m.Body!!
                .Span
                .Start <= token
                .Span
                .Start &&
                token
                .Span
                .End <= m.Body!!
                .Span
                .End
        )
        if !insideMethod {
            return nil
        }
        // Resolve the struct declaration to its symbol.
        let structSymbol = SemanticLookup.ResolveSymbol(compilation, enclosingDecl.Identifier) as StructSymbol
        return structSymbol
    }

    /// Resolves the receiver expression of an accessor to its (cref:StructSymbol)
    /// type (user-defined G# struct or class).
    private func ResolveReceiverStructSymbol(
        tree SyntaxTree,
        compilation Compilation,
        expression ExpressionSyntax
    ) StructSymbol? {
        // Issue #4989: the receiver's bound (flow) type is authoritative.
        let boundType = BoundSemantics.GetExpressionType(compilation, expression)
        if boundType != nil {
            return boundType as StructSymbol
        }
        switch expression {
            case name is NameExpressionSyntax {
                let symbol = SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken)
                return switch symbol {
                    case variable is VariableSymbol: variable.Type as StructSymbol
                    case structSym is StructSymbol: structSym
                    default: default(StructSymbol?)
                }
            }
            case call is CallExpressionSyntax {
                let callSymbol = SemanticLookup.ResolveSymbol(compilation, call.Identifier)
                return switch callSymbol {
                    case function is FunctionSymbol: function.Type as StructSymbol
                    case structSym is StructSymbol: structSym
                    default: default(StructSymbol?)
                }
            }
            case nestedAccessor is AccessorExpressionSyntax {
                // Chained access: resolve the intermediate member's type.
                if !TryGetAccessorMemberName(nestedAccessor.RightPart, token: nil, out var intermediateName) {
                    return nil
                }
                let outerStruct StructSymbol? = ResolveReceiverStructSymbol(tree, compilation, nestedAccessor.LeftPart)
                if outerStruct == nil {
                    return nil
                }
                if intermediateName == nil {
                    return nil
                }
                let member = LookupMemberOnStruct(outerStruct, intermediateName)
                return switch member {
                    case property is PropertySymbol: property.Type as StructSymbol
                    case field is FieldSymbol: field.Type as StructSymbol
                    case function is FunctionSymbol: function.Type as StructSymbol
                    default: default(StructSymbol?)
                }
            }
            default {
                return nil
            }
        }
    }

    /// Looks up a member (property, field, event, or method) by name on a G# struct/class symbol,
    /// including inherited members from base classes.
    private func LookupMemberOnStruct(structSymbol StructSymbol, memberName string) Symbol? {
        // ADR-0112: route through the canonical member-resolution layer so hover
        // shares the binder's single member lookup. MemberQuery.All preserves the
        // historic order (property → field → event → method, instance then static,
        // walking the base chain).
        return TypeMemberModel.LookupMember(structSymbol, memberName, MemberQuery.All)
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

    /// Issue #522 / #897: yields the member-resolution context for a token that is the
    /// (cref:PropertyInitializerSyntax.PropertyIdentifier) of a C#-style object
    /// initializer (`T(args) { Prop = v }`). The "receiver" is the constructor call
    /// ((cref:ObjectCreationExpressionSyntax.Target)) whose constructed type the
    /// property/field is looked up on — mirroring the accessor member contexts so the
    /// same CLR and G# resolution paths apply to initializer property names.
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

    private func TryGetAccessorMemberName(
        expression ExpressionSyntax,
        token SyntaxToken?,
        out memberName string?
    ) bool {
        memberName = switch expression {
            case name is NameExpressionSyntax when token == nil ||
                MatchesToken(name.IdentifierToken, token): name
                .IdentifierToken
                .Text
            case call is CallExpressionSyntax when token == nil ||
                MatchesToken(call.Identifier, token): call
                .Identifier
                .Text
            default: default(string?)
        }
        return memberName != nil
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

    private func TryResolveClrReceiver(
        tree SyntaxTree,
        compilation Compilation,
        expression ExpressionSyntax,
        out receiver ClrReceiver?
    ) bool {
        // Issue #4989: a value receiver's bound (flow) type first.
        if BoundSemantics.GetExpressionType(compilation, expression)?.ClrType is {} boundClrType {
            receiver = ClrReceiver(boundClrType, StaticMembers: false)
            return true
        }
        switch expression {
            case name is NameExpressionSyntax {
                if TryResolveClrTypeFromSymbol(
                    SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken),
                    out var symbolType
                ) &&
                    symbolType != nil {
                    receiver = ClrReceiver(symbolType, StaticMembers: false)
                    return true
                }
                let importedType Type? = SemanticLookup.ResolveImportedClrType(
                    tree,
                    compilation,
                    name.IdentifierToken.Text
                )
                if importedType != nil {
                    receiver = ClrReceiver(importedType, StaticMembers: true)
                    return true
                }
            }
            case call is CallExpressionSyntax when TryResolveClrTypeFromSymbol(
                SemanticLookup.ResolveSymbol(compilation, call.Identifier),
                out var callType
            ) &&
                callType != nil {
                receiver = ClrReceiver(callType!!, StaticMembers: false)
                return true
            }
            case constructorCall is CallExpressionSyntax {
                // A constructor call on an imported CLR type (e.g. `ProcessStartInfo("x")`)
                // whose identifier does not resolve to a symbol: fall back to resolving the
                // type by name so instance members of the constructed object are available
                // (object-initializer property names, etc.).
                let constructedType Type? = SemanticLookup.ResolveImportedClrType(
                    tree,
                    compilation,
                    constructorCall.Identifier.Text
                )
                if constructedType != nil {
                    receiver = ClrReceiver(constructedType, StaticMembers: false)
                    return true
                }
            }
            case accessor is AccessorExpressionSyntax when TryResolveClrMemberExpression(
                tree,
                compilation,
                accessor,
                out var memberType
            ) &&
                memberType != nil {
                receiver = ClrReceiver(memberType!!, StaticMembers: false)
                return true
            }
        }
        receiver = default(ClrReceiver?)
        return false
    }

    private func TryResolveClrMemberExpression(
        tree SyntaxTree,
        compilation Compilation,
        accessor AccessorExpressionSyntax,
        out memberType Type?
    ) bool {
        memberType = nil
        if !TryGetAccessorMemberName(accessor.RightPart, token: nil, out var memberName) {
            return false
        }
        if memberName == nil {
            return false
        }
        if !TryResolveClrReceiver(tree, compilation, accessor.LeftPart, out var receiver) || receiver == nil {
            let gsharpReceiver StructSymbol? = ResolveReceiverStructSymbol(tree, compilation, accessor.LeftPart)
            if gsharpReceiver == nil {
                return false
            }
            let gsharpMember = LookupMemberOnStruct(gsharpReceiver, memberName)
            return TryResolveClrTypeFromSymbol(gsharpMember, out memberType)
        }
        let flags = BindingFlags.Public | (
            if receiver.StaticMembers {
                BindingFlags.Static
            } else {
                BindingFlags.Instance
            }
        )
        let property PropertyInfo? = ClrTypeUtilities.SafeGetProperty(receiver.Type, memberName, flags)
        if property != nil && property.GetIndexParameters().Length == 0 {
            memberType = property.PropertyType
            return true
        }
        let field FieldInfo? = ClrTypeUtilities.SafeGetField(receiver.Type, memberName, flags)
        if field != nil {
            memberType = field.FieldType
            return true
        }
        let event EventInfo? = ClrTypeUtilities.SafeGetEvent(receiver.Type, memberName, flags)
        if event != nil {
            memberType = event.EventHandlerType
            return true
        }
        let method MethodInfo? = ClrTypeUtilities.SafeGetMethods(receiver.Type, flags).FirstOrDefault(
            (m MethodInfo) -> m.Name == memberName && !m.IsSpecialName
        )
        if method == nil {
            return false
        }
        memberType = method.ReturnType
        return true
    }

    private func TryResolveClrTypeFromSymbol(symbol Symbol?, out clrType Type?) bool {
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

    private func RenderHover(model HoverModel) string {
        let sb = StringBuilder()
        sb.Append("```gsharp\n").Append(model.Signature).Append("\n```")
        if model.OverloadCount > 1 {
            let others = model.OverloadCount - 1
            sb.Append(`

*(+ `).Append(
                others
            ).Append(
                if others == 1 {
                    " overload)*"
                } else {
                    " overloads)*"
                }
            )
        }
        for section in model.Documentation {
            sb.Append(`

`)
            if !string.IsNullOrEmpty(section.Heading) {
                sb.Append("**").Append(section.Heading).Append(`**

`)
            }
            sb.Append(section.Body)
        }
        return sb.ToString()
    }

    private func CountOverloads(compilation Compilation, function FunctionSymbol) int32 {
        // ADR-0112: count via the canonical layer (non-inherited, matching the
        // historic single-declaring-type count).
        if function.StaticOwnerType is StructSymbol staticOwner {
            return TypeMemberModel.GetMethods(
                staticOwner,
                function.Name,
                MemberQuery(includeInstance: false, includeStatic: true, includeInherited: false, MemberKinds.Method)
            )
                .Length
        }
        if function.ReceiverType is StructSymbol owner {
            return TypeMemberModel.GetMethods(
                owner,
                function.Name,
                MemberQuery(includeInstance: true, includeStatic: false, includeInherited: false, MemberKinds.Method)
            )
                .Length
        }
        return compilation.GlobalScope.Functions.Count((f FunctionSymbol) -> f.Name == function.Name)
    }

    // Surfaces ingested CLR documentation (ADR-0057 §6): imported symbols resolve their
    // companion .xml on demand via GetDocumentation(); authored G# docs (P2) flow through
    // the same path once attached. Symbols with no documentation render just the signature.
    private func BuildDocumentation(symbol Symbol) IReadOnlyList[HoverDocSection] {
        return HoverDocumentationRenderer.Render(symbol.GetDocumentation())
    }

    private func FormatType(type TypeSymbol) string {
        return type?.Name ?? "void"
    }

    /// Issue #906: classifies the receiver syntax of the call whose identifier is
    /// [`token`](paramref), so the program-wide imported-method scan can reject
    /// candidates with an inconsistent dispatch shape. A value receiver (a local,
    /// member access, call result, etc.) gates to instance / receiver-dispatched
    /// extension methods; a type-name receiver (`string`, `Console`,
    /// `System.Linq.Enumerable`, …) gates to plain static methods. When known,
    /// the receiver's CLR type is returned as a tie-breaker for same-shaped collisions.
    private func ClassifyCallReceiver(
        tree SyntaxTree,
        compilation Compilation,
        token SyntaxToken,
        out receiverClrType Type?
    ) SemanticLookup
        .CallReceiverGate {
        receiverClrType = nil
        // The hovered call is the right part of an accessor (`receiver.M(...)`); a
        // bare call (`M(...)`) has no receiver and keeps the legacy name+arity match.
        // A dotted chain such as `report.Checks.Single(...)` parses
        // right-associatively, so the token's enclosing accessors yield several
        // candidate receivers (`Checks`, then `report.Checks`). Pick the most
        // complete one — the widest span — so the receiver reflects the full chain
        // (`report.Checks`) rather than a bare trailing segment (`Checks`) that
        // would not resolve on its own.
        let receiverExpression ExpressionSyntax? = FindAccessorMemberContexts(tree, token)
            .Select((context(ReceiverExpression ExpressionSyntax, MemberName string)) -> context.ReceiverExpression)
            .Where((expr ExpressionSyntax) -> expr != nil)
            .OrderByDescending((expr ExpressionSyntax) -> expr.Span.Length)
            .FirstOrDefault()
        if receiverExpression == nil {
            return SemanticLookup.CallReceiverGate.None
        }
        switch receiverExpression {
            case name is NameExpressionSyntax {
                let symbol = SemanticLookup.ResolveSymbol(compilation, name.IdentifierToken)
                if IsValueSymbol(symbol) {
                    // Issue #4989: the receiver's bound (flow) type first.
                    receiverClrType = BoundSemantics.GetExpressionType(compilation, name)?.ClrType
                    if receiverClrType == nil {
                        TryResolveClrTypeFromSymbol(symbol, out receiverClrType)
                    }
                    return SemanticLookup.CallReceiverGate.Value
                }
                // A bare-name receiver that is not a value is a type-name receiver: a
                // declared/imported type, or a primitive keyword type (e.g.
                // `string.Concat(...)`). Resolve its CLR type from the reference context
                // (so it can be compared against candidate methods' declaring types),
                // preferring the imported/primitive resolution over a builtin TypeSymbol
                // whose ClrType may be unset.
                let primitiveClrName string? = PrimitiveClrTypeName(name.IdentifierToken.Text)
                if primitiveClrName != nil {
                    receiverClrType = SemanticLookup.ResolveImportedClrType(tree, compilation, primitiveClrName)
                    return SemanticLookup.CallReceiverGate.TypeName
                }
                let importedType Type? = SemanticLookup.ResolveImportedClrType(
                    tree,
                    compilation,
                    name.IdentifierToken.Text
                )
                if importedType != nil {
                    receiverClrType = importedType
                    return SemanticLookup.CallReceiverGate.TypeName
                }
                if symbol is TypeSymbol {
                    TryResolveClrTypeFromSymbol(symbol, out receiverClrType)
                    return SemanticLookup.CallReceiverGate.TypeName
                }
                return SemanticLookup.CallReceiverGate.None
            }
            case accessor is AccessorExpressionSyntax {
                // A dotted name that resolves wholesale to a type is a static receiver
                // (e.g. `System.Linq.Enumerable.Concat(...)`); otherwise it is a member
                // access on a value (e.g. `report.Checks.Single(...)`).
                if TryFlattenDottedName(accessor, out var dotted) && dotted != nil {
                    let dottedType Type? = SemanticLookup.ResolveImportedClrType(tree, compilation, dotted)
                    if dottedType != nil {
                        receiverClrType = dottedType
                        return SemanticLookup.CallReceiverGate.TypeName
                    }
                }
                if TryResolveClrReceiver(tree, compilation, accessor, out var clrReceiver) &&
                    clrReceiver != nil &&
                    !clrReceiver.StaticMembers {
                    receiverClrType = clrReceiver.Type
                }
                return SemanticLookup.CallReceiverGate.Value
            }
            default {
                // Call results, indexers, parenthesised/literal receivers are all values.
                if TryResolveClrReceiver(tree, compilation, receiverExpression, out var valueReceiver) &&
                    valueReceiver != nil &&
                    !valueReceiver.StaticMembers {
                    receiverClrType = valueReceiver.Type
                }
                return SemanticLookup.CallReceiverGate.Value
            }
        }
    }

    private func IsValueSymbol(symbol Symbol?) bool {
        return (symbol is VariableSymbol or PropertySymbol or FieldSymbol)
    }

    private func TryFlattenDottedName(expression ExpressionSyntax, out dotted string?) bool {
        dotted = switch expression {
            case name is NameExpressionSyntax: name.IdentifierToken.Text
            case accessor is AccessorExpressionSyntax when TryFlattenDottedName(accessor.LeftPart, out var left) &&
                accessor.RightPart is NameExpressionSyntax right: left +
                "." +
                right
                .IdentifierToken
                .Text
            default: default(string?)
        }
        return dotted != nil
    }

    private func PrimitiveClrTypeName(keyword string) string? {
        return switch keyword {
            case "bool": "System.Boolean"
            case "char": "System.Char"
            case "string": "System.String"
            case "int8" or "sbyte": "System.SByte"
            case "uint8" or "byte": "System.Byte"
            case "int16": "System.Int16"
            case "uint16": "System.UInt16"
            case "int32": "System.Int32"
            case "uint32": "System.UInt32"
            case "int64": "System.Int64"
            case "uint64": "System.UInt64"
            case "float32": "System.Single"
            case "float64": "System.Double"
            case "object": "System.Object"
            default: default(string?)
        }
    }
}

/// A rendered hover documentation section: an optional bold heading and a Markdown body.
/// @param Heading The section heading, or null for the lead (summary) section.
/// @param Body The Markdown body.
internal data class HoverDocSection(Heading string?, Body string) : IEquatable[HoverDocSection] { }

shared class ReferencesComputer {
    func ComputeReferences(
        uri DocumentUri,
        content DocumentContent,
        position Position,
        includeDeclaration bool,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[Location] {
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let offset = SemanticLookup.ToOffset(content, position)
        let token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let target Symbol? = SemanticLookup.ResolveSymbol(compilation, token, ct)
        if target == nil {
            return Array.Empty[Location]()
        }
        return SemanticLookup
            .FindReferences(compilation, target, ct)
            .Where((t SyntaxToken) -> includeDeclaration || !IsDeclaration(compilation, t, target))
            .Select((t SyntaxToken) -> Location{Uri: GetDocumentUri(t, uri), Range: SemanticLookup.ToRange(t)})
            .ToList()
    }

    func ComputeReferenceTokens(
        content DocumentContent,
        position Position,
        includeDeclaration bool,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[SyntaxToken] {
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let offset = SemanticLookup.ToOffset(content, position)
        let token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let target Symbol? = SemanticLookup.ResolveSymbol(compilation, token, ct)
        if target == nil {
            return Array.Empty[SyntaxToken]()
        }
        return SemanticLookup
            .FindReferences(compilation, target, ct)
            .Where((t SyntaxToken) -> includeDeclaration || !IsDeclaration(compilation, t, target))
            .ToList()
    }

    private func IsDeclaration(compilation Compilation, token SyntaxToken, target Symbol) bool {
        for declaration in SemanticLookup.FindReferences(compilation, target) {
            if !object.ReferenceEquals(declaration, token) || declaration.Span.Start != token.Span.Start {
                continue
            }
            let containingTree = compilation.SyntaxTrees.FirstOrDefault(
                (t SyntaxTree) -> t.Text == token.SyntaxTree?.Text
            ) ??
                compilation.SyntaxTrees[0]
            let parentDeclaration = FindSmallestContainingDeclaration(containingTree.Root, token)
            return switch parentDeclaration {
                case v is VariableDeclarationSyntax: object.ReferenceEquals(v.Identifier, token)
                case f is FunctionDeclarationSyntax: object.ReferenceEquals(f.Identifier, token)
                case p is ParameterSyntax: object.ReferenceEquals(p.Identifier, token)
                case s is StructDeclarationSyntax: object.ReferenceEquals(s.Identifier, token)
                case f is FieldDeclarationSyntax: object.ReferenceEquals(f.Identifier, token)
                case e is EnumDeclarationSyntax: object.ReferenceEquals(e.Identifier, token)
                case e is EnumMemberSyntax: object.ReferenceEquals(e.Identifier, token)
                default: false
            }
        }
        return false
    }

    private func GetDocumentUri(token SyntaxToken, fallback DocumentUri) DocumentUri {
        if !string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName) {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName)!!
        }
        return fallback
    }

    private func FindSmallestContainingDeclaration(node SyntaxNode, token SyntaxToken) SyntaxNode? {
        var best SyntaxNode? = nil
        let Visit = func (current SyntaxNode) {
            if current.Span.Start <= token.Span.Start && token.Span.End <= current.Span.End {
                if current is VariableDeclarationSyntax ||
                    current is FunctionDeclarationSyntax ||
                    current is ParameterSyntax ||
                    current is StructDeclarationSyntax ||
                    current is FieldDeclarationSyntax ||
                    current is EnumDeclarationSyntax ||
                    current is EnumMemberSyntax {
                    if best == nil || current.Span.Length < best.Span.Length {
                        best = current
                    }
                }
                for child in current.GetChildren() {
                    Visit(child)
                }
            }
        }
        Visit(node)
        return best
    }
}

shared class RenameComputer {
    func ComputeRename(
        uri DocumentUri,
        content DocumentContent,
        position Position,
        newName string,
        ct CancellationToken = default(CancellationToken)
    ) WorkspaceEdit? {
        if !SemanticLookup.IsValidIdentifier(newName) {
            return nil
        }
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let offset = SemanticLookup.ToOffset(content, position)
        let token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let target Symbol? = SemanticLookup.ResolveSymbol(compilation, token, ct)
        if target == nil || !SemanticLookup.CanRename(target) {
            return nil
        }
        let references = SemanticLookup.FindReferences(compilation, target, ct).ToList()
        if references.Count == 0 {
            return nil
        }
        // Group edits by document URI for cross-file rename support
        let editsByUri = Dictionary[DocumentUri, List[GSharp.LanguageServer.Protocol.TextEdit]]()
        for refToken in references {
            let docUri = GetDocumentUri(refToken, uri)
            if !editsByUri.TryGetValue(docUri, out var edits) {
                edits = List[GSharp.LanguageServer.Protocol.TextEdit]()
                editsByUri[docUri] = edits
            }
            edits.Add(
                GSharp.LanguageServer.Protocol.TextEdit{Range: SemanticLookup.ToRange(refToken), NewText: newName}
            )
        }
        return WorkspaceEdit{
            Changes: editsByUri.ToDictionary(
                (kv KeyValuePair[DocumentUri, List[GSharp.LanguageServer.Protocol.TextEdit]]) -> kv.Key,
                (kv KeyValuePair[DocumentUri, List[GSharp.LanguageServer.Protocol.TextEdit]]) -> cast[
                    IEnumerable[GSharp.LanguageServer.Protocol.TextEdit]
                ](kv.Value)
            )
        }
    }

    private func GetDocumentUri(token SyntaxToken, fallback DocumentUri) DocumentUri {
        if !string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName) {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName)!!
        }
        return fallback
    }
}

shared class DefinitionComputer {
    func ComputeDefinition(
        uri DocumentUri,
        content DocumentContent,
        position Position,
        ct CancellationToken = default(CancellationToken)
    ) Location? {
        let all = ComputeDefinitions(uri, content, position, ct)
        return if all.Count > 0 {
            all[0]
        } else {
            default(Location?)
        }
    }

    /// Like (cref:ComputeDefinition) but returns <em>every</em> declaration
    /// location. For a `partial` type (ADR-0144) this is one location per
    /// part (across files); for every other symbol it is a single-element list
    /// (or empty). The `textDocument/definition` handler returns this array.
    /// @param uri The URI of the document the request originated from (fallback when a target has no file
    /// path).
    /// @param content The document content and its owning project/workspace.
    /// @param position The cursor position whose symbol is being resolved.
    /// @param ct A cancellation token.
    /// @returns Every declaration location for the resolved symbol; empty when none resolves.
    func ComputeDefinitions(
        uri DocumentUri,
        content DocumentContent,
        position Position,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[Location] {
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token, ct)
        let workspace = content.Workspace
        // Imported symbols (cross-assembly): try sibling-G#-project source walk
        // first, then portable-PDB navigation. See CrossAssemblyDefinitionResolver.
        if TryResolveImportedSymbol(symbol, workspace, out var crossLocation) && crossLocation != nil {
            return []Location{crossLocation}
        }
        if symbol != nil {
            // ADR-0144: a partial type resolves to a synthetic merged declaration
            // that records every part's identifier location. Return them all.
            let partLocations IReadOnlyList[Location]? = GetPartialTypeLocations(symbol, uri)
            if partLocations != nil {
                return partLocations
            }
            let declarationToken SyntaxToken? = FindDeclarationToken(compilation, symbol, ct)
            if declarationToken != nil {
                let targetUri = GetDocumentUri(declarationToken, uri)
                return []Location{Location{Uri: targetUri, Range: SemanticLookup.ToRange(declarationToken)}}
            }
        }
        // Fallback: the token is on a CLR type name (e.g. `Console`) or a
        // member access RHS (e.g. `WriteLine` in `Console.WriteLine`) that did
        // not resolve to a G# symbol. Walk the import / member-access context
        // the same way HoverComputer does and map the result to a Location via
        // CrossAssemblyDefinitionResolver.
        if token != nil && token.Kind == SyntaxKind.IdentifierToken {
            if ImportedClrMemberResolver.TryResolveClrType(content.SyntaxTree, compilation, token, out var clrType) &&
                clrType != nil &&
                CrossAssemblyDefinitionResolver.TryResolveType(workspace, clrType, out var typeLocation) &&
                typeLocation != nil {
                return []Location{typeLocation}
            }
            if ImportedClrMemberResolver.TryResolveClrMember(
                content.SyntaxTree,
                compilation,
                token,
                out var clrMember
            ) &&
                clrMember != nil &&
                TryResolveClrMember(workspace, clrMember, out var memberLocation) &&
                memberLocation != nil {
                return []Location{memberLocation}
            }
        }
        return Array.Empty[Location]()
    }

    /// Returns one (cref:Location) per part of a merged `partial` type
    /// (ADR-0144), or `null` when [`symbol`](paramref) is not
    /// a multi-part partial struct/interface (so the caller falls through to the
    /// ordinary single-declaration path).
    private func GetPartialTypeLocations(symbol Symbol, fallback DocumentUri) IReadOnlyList[Location]? {
        let partLocations = switch symbol {
            case s is StructSymbol: s.Declaration?.PartialPartLocations ?? ImmutableArray[TextLocation].Empty
            case i is InterfaceSymbol: i.Declaration?.PartialPartLocations ?? ImmutableArray[TextLocation].Empty
            default: ImmutableArray[TextLocation].Empty
        }
        if partLocations.IsDefaultOrEmpty {
            return nil
        }
        let locations = List[Location]()
        for loc in partLocations {
            if loc.Text == nil {
                continue
            }
            locations.Add(
                Location{
                    Uri: if !string.IsNullOrEmpty(loc.FileName) {
                        DocumentUri.FromFileSystemPath(loc.FileName!!)
                    } else {
                        fallback
                    },
                    Range: SemanticLookup.ToRange(loc.Text!!, loc.Span)
                }
            )
        }
        return locations
    }

    private func TryResolveImportedSymbol(symbol Symbol?, workspace WorkspaceState?, out location Location?) bool {
        location = nil
        switch symbol {
            case importedClass is ImportedClassSymbol {
                return CrossAssemblyDefinitionResolver.TryResolveType(workspace, importedClass.ClassType, out location)
            }
            case importedType is ImportedTypeSymbol {
                return CrossAssemblyDefinitionResolver.TryResolveType(workspace, importedType.Type, out location)
            }
            case importedFunction is ImportedFunctionSymbol {
                return CrossAssemblyDefinitionResolver.TryResolveMethod(
                    workspace,
                    importedFunction.Method,
                    out location
                )
            }
            default {
                return false
            }
        }
    }

    private func TryResolveClrMember(workspace WorkspaceState?, member MemberInfo, out location Location?) bool {
        location = nil
        switch member {
            case method is MethodInfo {
                return CrossAssemblyDefinitionResolver.TryResolveMethod(workspace, method, out location)
            }
            case property is PropertyInfo {
                return CrossAssemblyDefinitionResolver.TryResolveProperty(workspace, property, out location)
            }
            case field is FieldInfo {
                return CrossAssemblyDefinitionResolver.TryResolveField(workspace, field, out location)
            }
            case event is EventInfo {
                return CrossAssemblyDefinitionResolver.TryResolveEvent(workspace, event, out location)
            }
            default {
                return false
            }
        }
    }

    private func GetDocumentUri(token SyntaxToken, fallback DocumentUri) DocumentUri {
        if !string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName) {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName)!!
        }
        return fallback
    }

    private func FindDeclarationToken(
        compilation Compilation,
        symbol Symbol,
        ct CancellationToken = default(CancellationToken)
    ) SyntaxToken? {
        return switch symbol {
            case f is FunctionSymbol when f.Declaration != nil: f.Declaration!!.Identifier
            case f is FunctionSymbol when f.LocalDeclaration != nil: f.LocalDeclaration!!.Identifier
            case s is StructSymbol when s.Declaration != nil: s.Declaration!!.Identifier
            case e is EnumSymbol when e.Declaration != nil: e.Declaration.Identifier
            case m is EnumMemberSymbol: FindEnumMemberToken(m)
            case p is PropertySymbol when p.Declaration != nil: p.Declaration!!.Identifier
            case ev is EventSymbol when ev.Declaration != nil: ev.Declaration!!.Identifier
            case field is FieldSymbol: FindFieldToken(compilation, field, ct)
            case variable is VariableSymbol: FindVariableToken(compilation, variable, ct)
            default: default(SyntaxToken?)
        }
    }

    private func FindEnumMemberToken(member EnumMemberSymbol) SyntaxToken? {
        if member.EnumType?.Declaration == nil {
            return nil
        }
        return member
            .EnumType
            .Declaration
            .Members
            .Select((m EnumMemberSyntax) -> m.Identifier)
            .FirstOrDefault((id SyntaxToken) -> id.Text == member.Name)
    }

    private func FindFieldToken(
        compilation Compilation,
        field FieldSymbol,
        ct CancellationToken = default(CancellationToken)
    ) SyntaxToken? {
        for tree in compilation.SyntaxTrees {
            ct.ThrowIfCancellationRequested()
            for structDecl in FindNodes[StructDeclarationSyntax](tree.Root) {
                for fieldDecl in structDecl.Fields {
                    if fieldDecl.Identifier.Text == field.Name {
                        return fieldDecl.Identifier
                    }
                }
            }
        }
        return nil
    }

    private func FindVariableToken(
        compilation Compilation,
        variable VariableSymbol,
        ct CancellationToken = default(CancellationToken)
    ) SyntaxToken? {
        for tree in compilation.SyntaxTrees {
            ct.ThrowIfCancellationRequested()
            for varDecl in FindNodes[VariableDeclarationSyntax](tree.Root) {
                if varDecl.Identifier.Text == variable.Name {
                    return varDecl.Identifier
                }
            }
            for funcDecl in FindNodes[FunctionDeclarationSyntax](tree.Root) {
                for param in funcDecl.Parameters {
                    // ADR-0185: a named function's parameters never come from
                    // the destructured arrow-lambda path.
                    if param.Identifier!!.Text == variable.Name {
                        return param.Identifier!!
                    }
                }
            }
        }
        return nil
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

shared class DocumentSymbolComputer {
    // Fallback names used when a declaration's identifier token is missing
    // (Text == null) or empty. Incomplete or error declarations produce such
    // synthesized tokens; the LSP `textDocument/documentSymbol` response must
    // never contain a symbol with a null/empty name, otherwise the
    // vscode-languageclient converter throws "name must not be falsy" and the
    // Outline view / breadcrumbs break (issue #890).
    private const AnonymousFunctionName string = "<function>"

    private const AnonymousVariableName string = "<variable>"
    private const AnonymousStructName string = "<struct>"
    private const AnonymousEnumName string = "<enum>"
    private const AnonymousFieldName string = "<field>"
    private const AnonymousEnumMemberName string = "<member>"

    func ComputeDocumentSymbols(
        content DocumentContent,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[SymbolInformationOrDocumentSymbol] {
        let result = List[SymbolInformationOrDocumentSymbol]()
        let text = content.SyntaxTree.Text
        for member in content.SyntaxTree.Root.Members {
            // Each member spawns its own child-collecting loop below; check between
            // top-level members so a superseded request aborts a large-file walk early.
            ct.ThrowIfCancellationRequested()
            switch member {
                case func_ is FunctionDeclarationSyntax {
                    result.Add(
                        SymbolInformationOrDocumentSymbol(
                            DocumentSymbol{
                                Name: SymbolName(func_.Identifier, AnonymousFunctionName),
                                Kind: LspSymbolKind.Function,
                                Range: SemanticLookup.ToRange(text, func_.Span),
                                SelectionRange: SemanticLookup.ToRange(func_.Identifier)
                            }
                        )
                    )
                }
                case GlobalStatementSyntax{Statement: VariableDeclarationSyntax variable} {
                    result.Add(
                        SymbolInformationOrDocumentSymbol(
                            DocumentSymbol{
                                Name: SymbolName(variable.Identifier, AnonymousVariableName),
                                Kind: LspSymbolKind.Variable,
                                Range: SemanticLookup.ToRange(text, variable.Span),
                                SelectionRange: SemanticLookup.ToRange(variable.Identifier)
                            }
                        )
                    )
                }
                case structDecl is StructDeclarationSyntax {
                    let children = List[DocumentSymbol]()
                    for field in structDecl.Fields {
                        children.Add(
                            DocumentSymbol{
                                Name: SymbolName(field.Identifier, AnonymousFieldName),
                                Kind: LspSymbolKind.Field,
                                Range: SemanticLookup.ToRange(text, field.Span),
                                SelectionRange: SemanticLookup.ToRange(field.Identifier)
                            }
                        )
                    }
                    result.Add(
                        SymbolInformationOrDocumentSymbol(
                            DocumentSymbol{
                                Name: SymbolName(structDecl.Identifier, AnonymousStructName),
                                Kind: LspSymbolKind.Struct,
                                Range: SemanticLookup.ToRange(text, structDecl.Span),
                                SelectionRange: SemanticLookup.ToRange(structDecl.Identifier),
                                Children: children
                            }
                        )
                    )
                }
                case enumDecl is EnumDeclarationSyntax {
                    let enumChildren = List[DocumentSymbol]()
                    for enumMember in enumDecl.Members {
                        enumChildren.Add(
                            DocumentSymbol{
                                Name: SymbolName(enumMember.Identifier, AnonymousEnumMemberName),
                                Kind: LspSymbolKind.EnumMember,
                                Range: SemanticLookup.ToRange(text, enumMember.Span),
                                SelectionRange: SemanticLookup.ToRange(enumMember.Identifier)
                            }
                        )
                    }
                    result.Add(
                        SymbolInformationOrDocumentSymbol(
                            DocumentSymbol{
                                Name: SymbolName(enumDecl.Identifier, AnonymousEnumName),
                                Kind: LspSymbolKind.Enum,
                                Range: SemanticLookup.ToRange(text, enumDecl.Span),
                                SelectionRange: SemanticLookup.ToRange(enumDecl.Identifier),
                                Children: enumChildren
                            }
                        )
                    )
                }
            }
        }
        return result
    }

    // Resolves a symbol name from an identifier token, substituting a non-empty
    // fallback when the token is missing/synthesized (Text == null) or empty or
    // whitespace. Guarantees the returned name is never null or empty so the
    // emitted DocumentSymbol always satisfies the LSP protocol contract.
    private func SymbolName(identifier SyntaxToken, fallback string) string {
        let name = identifier?.Text
        return if string.IsNullOrWhiteSpace(name) {
            fallback
        } else {
            name!!
        }
    }
}

shared class SignatureHelpComputer {
    func ComputeSignatureHelp(
        content DocumentContent,
        position Position,
        ct CancellationToken = default(CancellationToken)
    ) SignatureHelp? {
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let offset = SemanticLookup.ToOffset(content, position)
        // Walk backwards from cursor to find the function name token before the opening paren
        let source = content.SyntaxTree.Text.ToString()
        var parenDepth = 0
        var activeParameter = 0
        var funcNameEnd int32? = nil
        for var i = offset - 1; i >= 0; i-- {
            let c = source[i]
            if c == ')' {
                parenDepth++
            } else if c == '(' {
                if parenDepth > 0 {
                    parenDepth--
                } else {
                    funcNameEnd = i
                    break
                }
            } else if c == ',' && parenDepth == 0 {
                activeParameter++
            }
        }
        if funcNameEnd == nil {
            return nil
        }
        // Find the identifier token just before the paren
        var funcToken = SemanticLookup.FindTokenAt(content.SyntaxTree, funcNameEnd - 1)
        if funcToken?.Kind == SyntaxKind.CloseSquareBracketToken {
            funcToken = funcToken!!.FirstAncestorOrSelf[CallExpressionSyntax]()?.Identifier
        }
        let symbol = SemanticLookup.ResolveSymbol(compilation, funcToken, ct)
        if symbol is not FunctionSymbol function {
            return nil
        }
        let parameters = function
            .Parameters
            .Select((p ParameterSymbol) -> ParameterInformation{Label: "${p.Name} ${FormatType(p.Type)}"})
            .ToList()
        let signature = SignatureInformation{Label: HoverComputer.FormatSymbol(function), Parameters: parameters}
        return SignatureHelp{
            Signatures: []SignatureInformation{signature},
            ActiveSignature: 0,
            ActiveParameter: Math.Min(activeParameter, Math.Max(0, parameters.Count - 1))
        }
    }

    private func FormatType(type TypeSymbol) string {
        return type?.Name ?? "void"
    }
}

shared class CompletionComputer {
    func ComputeCompletions(
        content DocumentContent,
        position Position,
        ct CancellationToken = default(CancellationToken)
    ) IReadOnlyList[CompletionItem] {
        let compilation = content.Project?.GetCompilation() ?? Compilation(content.SyntaxTree)
        let offset = SemanticLookup.ToOffset(content, position)
        // Issue #917: completion-as-you-type. When the caret sits in (or immediately
        // after) a partial identifier — e.g. `prin<caret>` or `x.To<caret>` — compute
        // the prefix's span so each candidate carries an explicit replacement range.
        // This lets the editor filter/replace the partial word correctly when the list
        // is invoked implicitly mid-identifier rather than only after a trigger char.
        let replacementRange = ComputeReplacementRange(content, offset)
        let memberItems IReadOnlyList[CompletionItem]? = TryComputeMemberCompletions(content, compilation, offset)
        if memberItems != nil {
            return ApplyReplacementRange(memberItems, replacementRange)
        }
        let initializerItems IReadOnlyList[CompletionItem]? = TryComputeObjectInitializerCompletions(
            content,
            compilation,
            offset
        )
        if initializerItems != nil {
            return ApplyReplacementRange(initializerItems, replacementRange)
        }
        let items = List[CompletionItem]()
        let seen = HashSet[string](StringComparer.Ordinal)
        // Issue #713: in a type-clause position, surface the `async func(...) R`
        // (ADR-0043) and `async sequence[T]` (ADR-0042) snippets so the two
        // GSharp-flavored async-type spellings are discoverable. The snippets stay
        // out of every other completion context.
        TypeClauseCompletions.TryAddTypeClauseSnippets(items, seen, content.SyntaxTree, offset)
        // Add keywords
        for keyword in GetKeywords() {
            if seen.Add(keyword) {
                items.Add(CompletionItem{Label: keyword, Kind: CompletionItemKind.Keyword})
            }
        }
        let keywordNames = HashSet[string](seen, StringComparer.Ordinal)
        // Add the names visible at the caret: locals and parameters, the enclosing type's
        // members, then the compilation's functions, variables and types (ADR-0212 slice S3).
        let model = BoundSemantics.GetPositionModel(compilation, content.SyntaxTree)
        if model != nil {
            for symbol in model.LookupSymbols(offset, nil, ct) {
                ct.ThrowIfCancellationRequested()
                // A name that is a keyword is written with its `$` escape (ADR-0170).
                let written = if keywordNames.Contains(symbol.Name) || SyntaxFacts.IsReservedIdentifier(symbol.Name) {
                    "$" + symbol.Name
                } else {
                    symbol.Name
                }
                if seen.Add(written) {
                    items.Add(
                        CompletionItem{
                            Label: written,
                            Kind: GetCompletionKind(symbol),
                            Detail: HoverComputer.FormatSymbol(symbol)
                        }
                    )
                }
            }
        }
        // Type aliases (`type A = T`): LookupSymbols answers an alias by name with the type it names but
        // cannot list it, as that symbol carries the target's name. The names come from the trees'
        // declarations until an alias symbol exists (follow-up of ADR-0212 slice S3).
        if model != nil {
            for tree in compilation.SyntaxTrees {
                for aliasDeclaration in tree.Root.Members.OfType[TypeAliasDeclarationSyntax]() {
                    ct.ThrowIfCancellationRequested()
                    if aliasDeclaration.Identifier is not{} aliasIdentifier || aliasIdentifier.IsMissing {
                        continue
                    }
                    let aliasName = aliasIdentifier.Text
                    if !seen.Add(aliasName) {
                        continue
                    }
                    let target = model.LookupSymbols(offset, aliasName, ct)
                    let item = CompletionItem{Label: aliasName, Kind: CompletionItemKind.Class}
                    if !target.IsDefaultOrEmpty {
                        item.Kind = GetCompletionKind(target[0])
                        item.Detail = HoverComputer.FormatSymbol(target[0])
                    }
                    items.Add(item)
                }
            }
        }
        // Add primitive types
        for type in[]string{"bool", "int32", "string", "void"} {
            if seen.Add(type) {
                items.Add(CompletionItem{Label: type, Kind: CompletionItemKind.TypeParameter})
            }
        }
        return ApplyReplacementRange(items, replacementRange)
    }

    private func GetCompletionKind(symbol Symbol) CompletionItemKind {
        return switch symbol {
            case FunctionSymbol: CompletionItemKind.Function
            case VariableSymbol: CompletionItemKind.Variable
            case StructSymbol: CompletionItemKind.Struct
            case EnumSymbol: CompletionItemKind.Enum
            case FieldSymbol: CompletionItemKind.Field
            case PropertySymbol: CompletionItemKind.Property
            case EventSymbol: CompletionItemKind.Event
            default: CompletionItemKind.Class
        }
    }

    /// Issue #917: computes the source span of the partial identifier immediately
    /// preceding [`offset`](paramref) (the run of identifier characters ending at
    /// the caret). Returns `null` when the caret is not directly after
    /// an identifier character (e.g. right after a `.` trigger, or at the start of
    /// a fresh token) so the editor falls back to its own word-range heuristics.
    private func ComputeReplacementRange(content DocumentContent, offset int32) Range? {
        let text = content.SyntaxTree.Text
        if offset <= 0 || offset > text.Length {
            return nil
        }
        var start = offset
        while start > 0 && IsIdentifierChar(text[start - 1]) {
            start--
        }
        if start == offset {
            // No identifier prefix at the caret — nothing to anchor a replacement to.
            return nil
        }
        return SemanticLookup.ToRange(text, TextSpan(start, offset - start))
    }

    private func IsIdentifierChar(c char) bool -> char.IsLetterOrDigit(c) || c == '_'

    /// Issue #917: attaches the partial-identifier replacement range ([`replacementRange`](paramref))
    /// to every plain (non-snippet) candidate so the editor replaces the typed prefix
    /// instead of inserting alongside it. Snippet items (which carry their own
    /// (cref:CompletionItem.InsertText)) are left untouched. A `null`
    /// range leaves the list unchanged so the editor applies its default word range.
    private func ApplyReplacementRange(items IReadOnlyList[CompletionItem], replacementRange Range?) IReadOnlyList[
        CompletionItem
    ] {
        if replacementRange == nil || items.Count == 0 {
            return items
        }
        for item in items {
            if item.InsertText != nil || item.TextEdit != nil {
                continue
            }
            item.TextEdit = GSharp.LanguageServer.Protocol.TextEdit{Range: replacementRange, NewText: item.Label}
        }
        return items
    }

    /// Issue #522 / #897: when the caret sits inside a C#-style object-initializer
    /// block (`T(args) { Prop = v, <caret> }`) in a property-name position,
    /// returns the writable instance members (settable properties / writable fields)
    /// of the constructed type. Returns `null` when the caret is not
    /// in such a position so the caller falls back to the global completion list.
    private func TryComputeObjectInitializerCompletions(
        content DocumentContent,
        compilation Compilation,
        offset int32
    ) IReadOnlyList[CompletionItem]? {
        let root = content.SyntaxTree.Root
        let collection CollectionInitializerExpressionSyntax? = EnumerateNodes(root)
            .OfType[CollectionInitializerExpressionSyntax]()
            .Where(
            (candidate CollectionInitializerExpressionSyntax) -> candidate
                .Elements
                .OfType[MemberCollectionElementSyntax]()
                .Any((member MemberCollectionElementSyntax) -> IsInInitializerNamePosition(member, offset))
        )
            .OrderBy((candidate CollectionInitializerExpressionSyntax) -> candidate.Span.Length)
            .FirstOrDefault()
        let creation = EnumerateNodes(root)
            .OfType[ObjectCreationExpressionSyntax]()
            .Where((c ObjectCreationExpressionSyntax) -> IsInInitializerNamePosition(c, offset))
            .OrderBy((c ObjectCreationExpressionSyntax) -> c.Span.Length)
            .FirstOrDefault()
        var receiver ExpressionSyntax? = if collection != nil {
            SemanticLookup.GetInitializerTarget(collection)
        } else {
            creation?.Target
        }
        // Mid-typing recovery: `T(args) { Partial }` with no `=` parses the brace
        // block as a standalone BlockStatement abutting the constructor call. Recover
        // the constructor call as the receiver so the first property name still completes.
        receiver ??= TryFindOrphanInitializerReceiver(root, offset)
        if receiver == nil {
            return nil
        }
        let (function, locals) = SemanticLookup.GetExpressionBindingContext(compilation, content.SyntaxTree, offset)
        let receiverType TypeSymbol? = GSharp
            .Core
            .CodeAnalysis
            .Binding
            .Binder
            .TryInferExpressionType(
            compilation.GlobalScope,
            compilation.References ?? ReferenceResolver.Default(),
            function,
            locals,
            receiver
        )
        if receiverType == nil {
            // Caret is in an initializer position but the target type can't be inferred —
            // suppress the global list rather than offering irrelevant keywords/symbols.
            return List[CompletionItem]()
        }
        let items = List[CompletionItem]()
        let seen = HashSet[string](StringComparer.Ordinal)
        AddObjectInitializerMembers(receiverType, items, seen)
        return items
    }

    private func IsInInitializerNamePosition(
        member MemberCollectionElementSyntax,
        offset int32
    ) bool -> offset >= member
        .DotToken
        .Span
        .End &&
        offset <= member
        .Initializer
        .ColonToken
        .Span
        .Start

    /// Determines whether [`offset`](paramref) sits inside the braces of
    /// [`creation`](paramref) in a property-name position — i.e. not within the
    /// value expression of an existing initializer (where the global list belongs).
    private func IsInInitializerNamePosition(creation ObjectCreationExpressionSyntax, offset int32) bool {
        let open_ SyntaxToken? = creation.OpenBraceToken
        if open_ == nil || open_.IsMissing {
            return false
        }
        let start = open_.Span.End
        let end = if creation.CloseBraceToken != nil && !creation.CloseBraceToken.IsMissing {
            creation.CloseBraceToken.Span.Start
        } else {
            creation.Span.End
        }
        if offset < start || offset > end {
            return false
        }
        for initializer in creation.Initializers {
            let equals SyntaxToken? = initializer.EqualsToken
            if equals != nil && !equals.IsMissing && offset >= equals.Span.Start && offset <= initializer.Span.End {
                // Caret is on the value side of `Prop = value` — defer to the global list.
                return false
            }
        }
        return true
    }

    /// Recovers the constructor call that an object-initializer block belongs to when
    /// the block failed to parse as an (cref:ObjectCreationExpressionSyntax)
    /// (e.g. the first property name typed without a trailing `=`). The block then
    /// parses as a standalone (cref:BlockStatementSyntax) abutting the call.
    private func TryFindOrphanInitializerReceiver(root SyntaxNode, offset int32) ExpressionSyntax? {
        let block BlockStatementSyntax? = EnumerateNodes(root)
            .OfType[BlockStatementSyntax]()
            .Where(
            (b BlockStatementSyntax) -> b.OpenBraceToken != nil &&
                !b
                .OpenBraceToken
                .IsMissing &&
                offset >= b
                .OpenBraceToken
                .Span
                .End &&
                offset <= (
                if b.CloseBraceToken != nil && !b.CloseBraceToken.IsMissing {
                    b.CloseBraceToken.Span.Start
                } else {
                    b.Span.End
                }
            )
        )
            .OrderBy((b BlockStatementSyntax) -> b.Span.Length)
            .FirstOrDefault()
        if block == nil {
            return nil
        }
        let braceStart = block.OpenBraceToken.Span.Start
        // The receiver is a constructor call (or object creation) whose end immediately
        // precedes the block's open brace, separated only by whitespace.
        var best ExpressionSyntax? = nil
        for node in EnumerateNodes(root) {
            if node is not ExpressionSyntax candidate {
                continue
            }
            if !((node is CallExpressionSyntax || node is ObjectCreationExpressionSyntax)) {
                continue
            }
            if candidate
                .Span
                .End <= braceStart &&
                IsWhitespaceBetween(root.SyntaxTree, candidate.Span.End, braceStart) &&
                (best == nil || candidate.Span.End > best.Span.End) {
                best = candidate
            }
        }
        return best
    }

    private func IsWhitespaceBetween(tree SyntaxTree, start int32, end int32) bool {
        if end <= start {
            return true
        }
        let text = tree.Text.ToString(start, end - start)
        for ch in text {
            if !char.IsWhiteSpace(ch) {
                return false
            }
        }
        return true
    }

    /// Adds the writable instance members (settable properties / writable fields) of
    /// [`receiverType`](paramref) as object-initializer completions.
    private func AddObjectInitializerMembers(
        receiverType TypeSymbol,
        items List[CompletionItem],
        seen HashSet[string]
    ) {
        if receiverType is StructSymbol structSymbol {
            // ADR-0112 A1: route object-initializer completion through the canonical
            // member-resolution layer. Instance fields/properties, walking the base
            // chain, preserves the historic enumeration (fields then properties per
            // level) and the same writable-member set object initializers accept.
            AddStructMembersFromModel(
                items,
                seen,
                structSymbol,
                MemberQuery.Instance(MemberKinds.Field | MemberKinds.Property)
            )
            return
        }
        if receiverType is InterfaceSymbol interfaceSymbol {
            AddInterfaceInstanceMembers(items, seen, interfaceSymbol)
            return
        }
        let clrType Type? = receiverType?.ClrType
        if clrType == nil {
            return
        }
        let flags = BindingFlags.Public | BindingFlags.Instance
        for property in ClrTypeUtilities.SafeGetProperties(clrType, flags) {
            if property.CanWrite && property.GetIndexParameters().Length == 0 {
                AddItem(
                    items,
                    seen,
                    property.Name,
                    CompletionItemKind.Property,
                    "${property.Name}: ${property.PropertyType.Name}"
                )
            }
        }
        for field in ClrTypeUtilities.SafeGetFields(clrType, flags) {
            if !field.IsInitOnly && !field.IsLiteral {
                AddItem(items, seen, field.Name, CompletionItemKind.Field, "${field.Name}: ${field.FieldType.Name}")
            }
        }
    }

    private func TryComputeMemberCompletions(
        content DocumentContent,
        compilation Compilation,
        offset int32
    ) IReadOnlyList[CompletionItem]? {
        let accessor AccessorExpressionSyntax? = FindReceiverAccessor(content.SyntaxTree.Root, offset)
        if accessor == nil || EnumerateNodes(content.SyntaxTree.Root).OfType[MemberCollectionElementSyntax]().Any(
            (member MemberCollectionElementSyntax) -> IsInInitializerNamePosition(member, offset)
        ) {
            // A qualified construction's outer accessor must not steal an
            // explicit initializer designator from member-name completion.
            return nil
        }
        let items = List[CompletionItem]()
        let seen = HashSet[string](StringComparer.Ordinal)
        let chainRoot = FindChainRoot(content.SyntaxTree.Root, accessor)
        let isSimpleNameReceiver = object.ReferenceEquals(chainRoot, accessor) &&
            accessor.LeftPart is NameExpressionSyntax simpleName &&
            !simpleName
            .IdentifierToken
            .IsMissing
        if !isSimpleNameReceiver {
            // Complex or chained receivers — `(a + b).`, `foo().`, `arr[0].`,
            // `a.b.`, etc. Reconstruct the full receiver expression (chains parse
            // right-nested, so the trailing accessor's LeftPart is only the last
            // segment) and speculatively bind it to infer the member type.
            let receiverExpression ExpressionSyntax? = ReconstructReceiverExpression(content, chainRoot, accessor)
            if receiverExpression != nil {
                let (function, locals) = SemanticLookup.GetExpressionBindingContext(
                    compilation,
                    content.SyntaxTree,
                    offset
                )
                // Issue #4989: the receiver's bound (flow) type when the binder has
                // one; a speculative bind of the reconstructed chain otherwise
                // (incomplete code). The bound query takes the receiver segment in
                // the document's own tree, which the binder indexed.
                let receiverType TypeSymbol? = BoundSemantics.GetExpressionType(compilation, accessor.LeftPart) ??
                    GSharp
                    .Core
                    .CodeAnalysis
                    .Binding
                    .Binder
                    .TryInferExpressionType(
                    compilation.GlobalScope,
                    compilation.References ?? ReferenceResolver.Default(),
                    function,
                    locals,
                    receiverExpression
                )
                if receiverType != nil {
                    AddInstanceTypeMembers(items, seen, receiverType)
                }
            }
            // Whether or not inference succeeded, suppress the global keyword list
            // since the caret sits in a member-access position.
            return items
        }
        let leftName = cast[NameExpressionSyntax](accessor.LeftPart)
        let receiver = SemanticLookup.ResolveSymbol(compilation, leftName.IdentifierToken)
        // Issue #4989: a value receiver's bound (flow) type over its declared one.
        let boundReceiverType TypeSymbol? = BoundSemantics.GetExpressionType(compilation, leftName)
        switch receiver {
            case variable is VariableSymbol {
                AddInstanceTypeMembers(items, seen, boundReceiverType ?? variable.Type)
            }
            case property is PropertySymbol {
                AddInstanceTypeMembers(items, seen, boundReceiverType ?? property.Type)
            }
            case field is FieldSymbol {
                AddInstanceTypeMembers(items, seen, boundReceiverType ?? field.Type)
            }
            case event is EventSymbol {
                AddInstanceTypeMembers(items, seen, boundReceiverType ?? event.Type)
            }
            case enumSymbol is EnumSymbol {
                AddEnumMembers(items, seen, enumSymbol)
            }
            case structType is StructSymbol {
                AddStructStaticMembers(items, seen, structType)
            }
            case typeSymbol is TypeSymbol {
                AddClrMembers(items, seen, typeSymbol.ClrType, staticMembers: true)
            }
            case nil {
                // An imported CLR type referenced by name (e.g. `Console`).
                AddClrMembers(
                    items,
                    seen,
                    SemanticLookup.ResolveImportedClrType(
                        content.SyntaxTree,
                        compilation,
                        leftName.IdentifierToken.Text
                    ),
                    staticMembers: true
                )
            }
        }
        return items
    }

    /// Finds the outermost postfix expression (member access or index) that ends
    /// at the same position as [`accessor`](paramref) — i.e. the root of the
    /// receiver chain. Member-access chains parse right-nested, so the trailing
    /// dot's accessor covers only the final segment; the chain root spans the whole
    /// receiver.
    private func FindChainRoot(root SyntaxNode, accessor AccessorExpressionSyntax) ExpressionSyntax {
        var best ExpressionSyntax = accessor
        for node in EnumerateNodes(root) {
            if !((node is AccessorExpressionSyntax || node is IndexExpressionSyntax)) {
                continue
            }
            let candidate = cast[ExpressionSyntax](node)
            if candidate
                .Span
                .End == accessor
                .Span
                .End &&
                candidate
                .Span
                .Start <= best
                .Span
                .Start &&
                candidate
                .Span
                .Start <= accessor
                .Span
                .Start {
                best = candidate
            }
        }
        return best
    }

    /// Reconstructs the receiver expression to the left of the trailing dot. When
    /// the receiver is the accessor's own (non-chained) left part it is returned
    /// directly; for chained receivers the source text between the chain root and
    /// the trailing dot is re-parsed into a standalone expression.
    private func ReconstructReceiverExpression(
        content DocumentContent,
        chainRoot ExpressionSyntax,
        accessor AccessorExpressionSyntax
    ) ExpressionSyntax? {
        if object.ReferenceEquals(chainRoot, accessor) {
            return accessor.LeftPart
        }
        let dotStart = accessor.DotToken.Span.Start
        let start = chainRoot.Span.Start
        if dotStart <= start {
            return nil
        }
        let text = content.SyntaxTree.Text.ToString(start, dotStart - start)
        let tree = SyntaxTree.Parse(text)
        return EnumerateNodes(tree.Root).OfType[ExpressionSyntax]().FirstOrDefault()
    }

    private func EnumerateNodes(node SyntaxNode) sequence[SyntaxNode] {
        yield node
        for child in node.GetChildren() {
            if child is SyntaxToken {
                continue
            }
            for descendant in EnumerateNodes(child) {
                yield descendant
            }
        }
    }

    private func FindReceiverAccessor(node SyntaxNode, offset int32) AccessorExpressionSyntax? {
        var best AccessorExpressionSyntax? = nil
        for accessor in FindAccessors(node) {
            let dot SyntaxToken? = accessor.DotToken
            if dot == nil || dot.IsMissing {
                continue
            }
            // Caret must sit after the dot and within the accessor expression.
            if dot.Span.End <= offset && offset <= accessor.Span.End {
                if best == nil || dot.Span.End > best.DotToken.Span.End {
                    best = accessor
                }
            }
        }
        return best
    }

    private func FindAccessors(node SyntaxNode) sequence[AccessorExpressionSyntax] {
        if node is AccessorExpressionSyntax accessor {
            yield accessor
        }
        for child in node.GetChildren() {
            for descendant in FindAccessors(child) {
                yield descendant
            }
        }
    }

    private func AddInstanceTypeMembers(items List[CompletionItem], seen HashSet[string], type TypeSymbol) {
        // ADR-0172: a tuple receiver offers its declared element names first,
        // then the positional ItemN spellings (both resolve).
        if type is TupleTypeSymbol tupleType {
            for var i = 0; i < tupleType.Arity; i++ {
                let elementDetail = SymbolDisplay.ToTypeDisplayString(tupleType.ElementTypes[i])
                if tupleType.HasNames && tupleType.ElementNames[i] is {} elementName && seen.Add(elementName) {
                    items.Add(CompletionItem{Label: elementName, Kind: CompletionItemKind.Field, Detail: elementDetail})
                }
                let positional = "Item" + (i + 1).ToString(CultureInfo.InvariantCulture)
                if seen.Add(positional) {
                    items.Add(CompletionItem{Label: positional, Kind: CompletionItemKind.Field, Detail: elementDetail})
                }
            }
            return
        }
        if type is StructSymbol structType {
            AddStructInstanceMembers(items, seen, structType)
            return
        }
        if type is InterfaceSymbol interfaceType {
            AddInterfaceInstanceMembers(items, seen, interfaceType)
            return
        }
        AddClrMembers(items, seen, type?.ClrType, staticMembers: false)
    }

    private func AddInterfaceInstanceMembers(
        items List[CompletionItem],
        seen HashSet[string],
        interfaceType InterfaceSymbol
    ) {
        // ADR-0112: enumerate user-declared interface members (this interface
        // and its user base interfaces) through the canonical layer.
        for member in TypeMemberModel.EnumerateMembers(
            interfaceType,
            MemberQuery.Instance(MemberKinds.Property | MemberKinds.Event | MemberKinds.Method)
        ) {
            switch member {
                case property is PropertySymbol {
                    AddItem(
                        items,
                        seen,
                        property.Name,
                        CompletionItemKind.Property,
                        "${property.Name}: ${property.Type?.Name}"
                    )
                }
                case event is EventSymbol {
                    AddItem(items, seen, event.Name, CompletionItemKind.Event, event.Name)
                }
                case method is FunctionSymbol {
                    AddItem(items, seen, method.Name, CompletionItemKind.Method, HoverComputer.FormatSymbol(method))
                }
            }
        }
        // Issue #1181: a user interface that extends an imported/BCL interface
        // also surfaces that interface's (and its transitive CLR bases')
        // members on an interface-typed receiver — keep the completion surface
        // consistent with the binder's member resolution.
        for clrBaseIface in ClrTypeUtilities.GetTransitiveClrBaseInterfaces(interfaceType) {
            AddClrMembers(items, seen, clrBaseIface, staticMembers: false)
        }
    }

    private func AddStructInstanceMembers(items List[CompletionItem], seen HashSet[string], structType StructSymbol) {
        // ADR-0112: enumerate instance members through the canonical layer.
        // Events are intentionally excluded to preserve the historic completion
        // set (fields, properties, methods only), walking the base chain.
        AddStructMembersFromModel(
            items,
            seen,
            structType,
            MemberQuery.Instance(MemberKinds.Field | MemberKinds.Property | MemberKinds.Method)
        )
    }

    private func AddStructStaticMembers(items List[CompletionItem], seen HashSet[string], structType StructSymbol) {
        // ADR-0112: static members through the canonical layer (no base-chain
        // walk, fields/properties/methods only — matching historic behavior).
        AddStructMembersFromModel(
            items,
            seen,
            structType,
            MemberQuery.Static(MemberKinds.Field | MemberKinds.Property | MemberKinds.Method)
        )
    }

    private func AddStructMembersFromModel(
        items List[CompletionItem],
        seen HashSet[string],
        structType StructSymbol,
        query MemberQuery
    ) {
        for member in TypeMemberModel.EnumerateMembers(structType, query) {
            switch member {
                case field is FieldSymbol {
                    AddItem(items, seen, field.Name, CompletionItemKind.Field, HoverComputer.FormatSymbol(field))
                }
                case property is PropertySymbol {
                    AddItem(
                        items,
                        seen,
                        property.Name,
                        CompletionItemKind.Property,
                        "${property.Name}: ${property.Type?.Name}"
                    )
                }
                case method is FunctionSymbol {
                    AddItem(items, seen, method.Name, CompletionItemKind.Method, HoverComputer.FormatSymbol(method))
                }
            }
        }
    }

    private func AddEnumMembers(items List[CompletionItem], seen HashSet[string], enumSymbol EnumSymbol) {
        for member in enumSymbol.Members {
            AddItem(items, seen, member.Name, CompletionItemKind.EnumMember, "${enumSymbol.Name}.${member.Name}")
        }
    }

    private func AddClrMembers(items List[CompletionItem], seen HashSet[string], clrType Type?, staticMembers bool) {
        if clrType == nil {
            return
        }
        if clrType == nil {
            return
        }
        let flags = BindingFlags.Public | (
            if staticMembers {
                BindingFlags.Static
            } else {
                BindingFlags.Instance
            }
        )
        for property in ClrTypeUtilities.SafeGetProperties(clrType, flags) {
            if property.GetIndexParameters().Length == 0 {
                AddItem(
                    items,
                    seen,
                    property.Name,
                    CompletionItemKind.Property,
                    "${property.Name}: ${property.PropertyType.Name}"
                )
            }
        }
        for field in ClrTypeUtilities.SafeGetFields(clrType, flags) {
            let kind = if field.IsLiteral {
                CompletionItemKind.Constant
            } else {
                CompletionItemKind.Field
            }
            AddItem(items, seen, field.Name, kind, "${field.Name}: ${field.FieldType.Name}")
        }
        for method in ClrTypeUtilities.SafeGetMethods(clrType, flags) {
            if method.IsSpecialName {
                continue
            }
            AddItem(
                items,
                seen,
                method.Name,
                CompletionItemKind.Method,
                "${method.Name}(...): ${method.ReturnType.Name}"
            )
        }
        for evt in ClrTypeUtilities.SafeGetEvents(clrType, flags) {
            AddItem(items, seen, evt.Name, CompletionItemKind.Event, evt.Name)
        }
    }

    private func AddItem(
        items List[CompletionItem],
        seen HashSet[string],
        label string,
        kind CompletionItemKind,
        detail string
    ) {
        var label = label
        if string.IsNullOrEmpty(label) || !seen.Add(label) {
            return
        }
        // ADR-0170 / issue #3610: a member whose CLR name is a G# reserved
        // spelling completes as its escaped form so the inserted text parses
        // (`x.$defer()` for an imported member named `defer`). The escape is
        // the label too — what you see is what inserts, mirroring how C#
        // completion shows `@params`.
        if SyntaxFacts.IsReservedIdentifier(label) {
            label = "$$" + label
        }
        items.Add(CompletionItem{Label: label, Kind: kind, Detail: detail})
    }

    private func GetKeywords() sequence[string] {
        yield "let"
        yield "func"
        yield "if"
        yield "else"
        yield "while"
        yield "for"
        yield "in"
        yield "return"
        yield "break"
        yield "continue"
        yield "true"
        yield "false"
        yield "type"
        yield "struct"
        yield "class"
        yield "enum"
        yield "protocol"
        yield "import"
        yield "switch"
        yield "case"
        yield "default"
        yield "go"
        yield "select"
        yield "scope"
        yield "defer"
        yield "when"
        yield "try"
        yield "catch"
        yield "throw"
        yield "rethrow"
        yield "async"
        yield "suspend"
        yield "await"
    }
}
