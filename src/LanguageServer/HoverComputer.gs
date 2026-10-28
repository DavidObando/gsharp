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
        let compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
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
            BuildHoverModel(symbol, compilation, token)
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
        // An imported method renders from its reflected signature, so each overload has its own label.
        if symbol is ImportedFunctionSymbol imported {
            return SymbolDisplay.ToDisplayString(imported.Method, SymbolDisplayFormat.Signature)
        }
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

    private func BuildHoverModel(symbol Symbol, compilation Compilation, token SyntaxToken? = nil) HoverModel {
        let signature = SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Hover, compilation)
        let overloadCount = if symbol is FunctionSymbol function {
            CountOverloads(compilation, function, token)
        } else {
            1
        }
        return HoverModel(signature, BuildDocumentation(symbol), overloadCount)
    }

    private func BuildImportedClrModel(tree SyntaxTree, compilation Compilation, token SyntaxToken?) HoverModel? {
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return nil
        }
        // The imported member the binder bound the token to, else the member of the receiver's type,
        // wins over a type of the same name (`Single` in `items.Single(...)` is not `System.Single`).
        if MemberTokenResolver.TryResolveMember(tree, compilation, token, out var member, out var overloadCount) &&
            BoundSemantics.GetMemberInfo(member) is {} memberInfo {
            return BuildMemberModel(memberInfo, overloadCount)
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
        return nil
    }

    private func BuildMemberModel(member MemberInfo, overloadCount int32) HoverModel? {
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
            case SyntaxKind.Utf8StringToken: "readonly span[byte]"
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
        // object-initializer property name (e.g. Point() { X = 1 }): the member of the
        // receiver's type (ADR-0212 slice S4).
        if MemberTokenResolver.TryResolveMember(tree, compilation, token, out var resolved, out _) &&
            resolved != nil &&
            !BoundSemantics.IsImportedMember(resolved) {
            return resolved
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

    /// Looks up a member (property, field, event, or method) by name on a G# struct/class symbol,
    /// including inherited members from base classes.
    private func LookupMemberOnStruct(structSymbol StructSymbol, memberName string) Symbol? {
        // ADR-0112: route through the canonical member-resolution layer so hover
        // shares the binder's single member lookup. MemberQuery.All preserves the
        // historic order (property → field → event → method, instance then static,
        // walking the base chain).
        return TypeMemberModel.LookupMember(structSymbol, memberName, MemberQuery.All)
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

    private func CountOverloads(compilation Compilation, function FunctionSymbol, token SyntaxToken?) int32 {
        // A call counts the candidates that overload resolution considered (ADR-0212 slice S4).
        if token?.Parent is CallExpressionSyntax call && object.ReferenceEquals(call.Identifier, token) {
            let group = BoundSemantics.GetMemberGroup(compilation, token)
            if !group.IsDefaultOrEmpty {
                return group.Length
            }
        }
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
        let compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
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
        let compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
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
        let compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
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
        let compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
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
            if MemberTokenResolver.TryResolveImportedType(content.SyntaxTree, compilation, token, out var clrType) &&
                clrType != nil &&
                CrossAssemblyDefinitionResolver.TryResolveType(workspace, clrType, out var typeLocation) &&
                typeLocation != nil {
                return []Location{typeLocation}
            }
            if MemberTokenResolver.TryResolveImportedMember(
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
        let compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
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
        // One signature per candidate that overload resolution considered (ADR-0212 slice S4); the
        // overload the call resolved to is the active one.
        let group = BoundSemantics.GetMemberGroup(compilation, funcToken)
        let resolved = BoundSemantics.GetImportedSymbol(compilation, funcToken) ?? SemanticLookup.ResolveSymbol(
            compilation,
            funcToken,
            ct
        )
        let candidates = group.Where((g Symbol) -> g is FunctionSymbol or ImportedFunctionSymbol).ToList()
        if candidates.Count == 0 && resolved is FunctionSymbol single {
            candidates.Add(single)
        }
        if candidates.Count == 0 {
            return nil
        }
        let signatures = candidates.Select((c Symbol) -> BuildSignature(c)).ToList()
        var active = candidates.FindIndex((c Symbol) -> object.ReferenceEquals(c, resolved))
        // A constructed owner substitutes the candidates; the selected callee is the declared one.
        if active < 0 && resolved is FunctionSymbol{Declaration: {} resolvedDeclaration} {
            active = candidates.FindIndex(
                (c Symbol) -> c is FunctionSymbol candidate && object.ReferenceEquals(
                    candidate.Declaration,
                    resolvedDeclaration
                )
            )
        }
        if active < 0 && resolved is ImportedFunctionSymbol resolvedImported {
            active = candidates.FindIndex(
                (c Symbol) -> c is ImportedFunctionSymbol imported && imported.Method.MetadataToken ==
                resolvedImported
                    .Method
                    .MetadataToken &&
                    imported
                    .Method
                    .Module == resolvedImported
                    .Method
                    .Module &&
                    imported
                    .Method
                    .DeclaringType == resolvedImported
                    .Method
                    .DeclaringType
            )
        }
        active = Math.Max(active, 0)
        let activeCount = signatures[active].Parameters.Count()
        return SignatureHelp{
            Signatures: signatures,
            ActiveSignature: active,
            ActiveParameter: Math.Min(activeParameter, Math.Max(0, activeCount - 1))
        }
    }

    private func BuildSignature(candidate Symbol) SignatureInformation {
        let parameters = switch candidate {
            case function is FunctionSymbol: function
                .Parameters
                .Select((p ParameterSymbol) -> ParameterInformation{Label: "${p.Name} ${FormatType(p.Type)}"})
                .ToList()
            case imported is ImportedFunctionSymbol: ImportedFunctionSymbol
                .GetLogicalParameters(imported.Method)
                .Select(
                (p ParameterInfo) -> ParameterInformation{
                    Label: "${p.Name} ${SymbolDisplay.ToTypeDisplayString(p.ParameterType, SymbolDisplayFormat.Signature.QualifyNames)}"
                }
            )
                .ToList()
            default: List[ParameterInformation]()
        }
        return SignatureInformation{Label: HoverComputer.FormatSymbol(candidate), Parameters: parameters}
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
        let compilation = content.Project?.GetCompilation() ?? ServerCompilation.Create(content.SyntaxTree)
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
                    // The semantic name finds the alias; a keyword-named alias is written with its escape.
                    let aliasName = aliasIdentifier.ValueText
                    let written = if keywordNames.Contains(aliasName) || SyntaxFacts.IsReservedIdentifier(aliasName) {
                        "$" + aliasName
                    } else {
                        aliasName
                    }
                    if !seen.Add(written) {
                        continue
                    }
                    let target = model.LookupSymbols(offset, aliasName, ct)
                    let item = CompletionItem{Label: written, Kind: CompletionItemKind.Class}
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
        let receiverType TypeSymbol? = BoundSemantics
            .GetPositionModel(compilation, content.SyntaxTree)
            ?.GetSpeculativeTypeInfo(offset, receiver)
            .Type
        if receiverType == nil {
            // Caret is in an initializer position but the target type can't be inferred —
            // suppress the global list rather than offering irrelevant keywords/symbols.
            return List[CompletionItem]()
        }
        let items = List[CompletionItem]()
        let seen = HashSet[string](StringComparer.Ordinal)
        AddObjectInitializerMembers(content, compilation, offset, receiverType, items, seen)
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
        content DocumentContent,
        compilation Compilation,
        offset int32,
        receiverType TypeSymbol,
        items List[CompletionItem],
        seen HashSet[string]
    ) {
        AddMembers(items, seen, content, compilation, offset, receiverType, staticMembers: false, initializer: true)
    }

    /// Adds the members of [`type`](paramref) that a member access at [`offset`](paramref) can name
    /// (ADR-0212 slice S4, `SemanticModel.LookupMembers`). A value receiver offers instance members; a
    /// type name offers static ones. An enum offers its members for the type name only. A source class or
    /// struct offers no events, as before. An interface name offers nothing.
    private func AddMembers(
        items List[CompletionItem],
        seen HashSet[string],
        content DocumentContent,
        compilation Compilation,
        offset int32,
        type TypeSymbol?,
        staticMembers bool,
        initializer bool = false
    ) {
        if type == nil {
            return
        }
        var receiver TypeSymbol = type
        while receiver is NullableTypeSymbol or PlatformTypeSymbol {
            receiver = if receiver is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                cast[PlatformTypeSymbol](receiver).UnderlyingType
            }
        }
        if staticMembers && receiver is InterfaceSymbol {
            return
        }
        for member in BoundSemantics.LookupMembers(compilation, content.SyntaxTree, offset, type) {
            if receiver is EnumSymbol {
                if !staticMembers {
                    continue
                }
            } else if MemberTokenResolver.IsStatic(member) != staticMembers {
                continue
            }
            if receiver is StructSymbol && member is EventSymbol {
                continue
            }
            if initializer && !IsInitializable(member, receiver) {
                continue
            }
            AddMemberItem(items, seen, member)
        }
    }

    // The members that an object initializer sets: the fields and properties of a source type, the
    // settable properties and writable fields of an imported one, every member of an interface.
    private func IsInitializable(member Symbol, receiver TypeSymbol) bool {
        if receiver is InterfaceSymbol {
            return true
        }
        return switch member {
            case property is PropertySymbol: receiver is StructSymbol && !BoundSemantics.IsImportedMember(property) ||
                property.HasSetter
            case field is FieldSymbol: receiver is StructSymbol && !BoundSemantics.IsImportedMember(field) ||
                (!field.IsReadOnly && !field.IsConst)
            default: false
        }
    }

    private func AddMemberItem(items List[CompletionItem], seen HashSet[string], member Symbol) {
        if string.IsNullOrEmpty(member.Name) || seen.Contains(member.Name) {
            return
        }
        switch member {
            case field is FieldSymbol {
                AddItem(
                    items,
                    seen,
                    field.Name,
                    if field.IsConst {
                        CompletionItemKind.Constant
                    } else {
                        CompletionItemKind.Field
                    },
                    if BoundSemantics.IsImportedMember(field) {
                        "${field.Name}: ${SymbolDisplay.ToTypeDisplayString(field.Type)}"
                    } else {
                        HoverComputer.FormatSymbol(field)
                    }
                )
            }
            case property is PropertySymbol {
                AddItem(
                    items,
                    seen,
                    property.Name,
                    CompletionItemKind.Property,
                    "${property.Name}: ${SymbolDisplay.ToTypeDisplayString(property.Type)}"
                )
            }
            case clrEvent is EventSymbol {
                AddItem(items, seen, clrEvent.Name, CompletionItemKind.Event, clrEvent.Name)
            }
            case enumMember is EnumMemberSymbol {
                AddItem(
                    items,
                    seen,
                    enumMember.Name,
                    CompletionItemKind.EnumMember,
                    "${enumMember.EnumType.Name}.${enumMember.Name}"
                )
            }
            case FunctionSymbol or ImportedFunctionSymbol {
                AddItem(items, seen, member.Name, CompletionItemKind.Method, HoverComputer.FormatSymbol(member))
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
                // Issue #4989: the receiver's bound (flow) type when the binder has
                // one; a speculative bind of the reconstructed chain otherwise
                // (incomplete code). The bound query takes the receiver segment in
                // the document's own tree, which the binder indexed.
                let receiverType TypeSymbol? = BoundSemantics.GetExpressionType(compilation, accessor.LeftPart) ??
                    BoundSemantics
                    .GetPositionModel(compilation, content.SyntaxTree)
                    ?.GetSpeculativeTypeInfo(offset, receiverExpression)
                    .Type
                if receiverType != nil {
                    AddMembers(items, seen, content, compilation, offset, receiverType, staticMembers: false)
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
                AddMembers(
                    items,
                    seen,
                    content,
                    compilation,
                    offset,
                    boundReceiverType ?? variable.Type,
                    staticMembers: false
                )
            }
            case property is PropertySymbol {
                AddMembers(
                    items,
                    seen,
                    content,
                    compilation,
                    offset,
                    boundReceiverType ?? property.Type,
                    staticMembers: false
                )
            }
            case field is FieldSymbol {
                AddMembers(
                    items,
                    seen,
                    content,
                    compilation,
                    offset,
                    boundReceiverType ?? field.Type,
                    staticMembers: false
                )
            }
            case event is EventSymbol {
                AddMembers(
                    items,
                    seen,
                    content,
                    compilation,
                    offset,
                    boundReceiverType ?? event.Type,
                    staticMembers: false
                )
            }
            case typeSymbol is TypeSymbol {
                AddMembers(items, seen, content, compilation, offset, typeSymbol, staticMembers: true)
            }
            case nil {
                // An imported CLR type referenced by name (e.g. `Console`).
                let imported Type? = SemanticLookup.ResolveImportedClrType(
                    content.SyntaxTree,
                    compilation,
                    leftName.IdentifierToken.Text
                )
                if imported != nil {
                    AddMembers(
                        items,
                        seen,
                        content,
                        compilation,
                        offset,
                        ImportedTypeSymbol.Get(imported),
                        staticMembers: true
                    )
                }
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
