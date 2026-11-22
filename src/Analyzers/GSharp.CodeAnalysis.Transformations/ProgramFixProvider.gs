// <copyright file="ProgramFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.CodeAnalysis.Transformations

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text
import System.Threading

/// A code-fix provider that interprets (cref:TransformationProgram)s (ADR-0227 D6). It is pure and
/// deterministic: a program matches its pattern at the token where the diagnostic starts, checks
/// its guards with public (cref:SemanticModel) queries, and records its edits with a
/// (cref:SyntaxEditor). Its fixes are data-defined, so a host runs the full delta gate on them.
class ProgramFixProvider : GSharpCodeFixProvider {
    /// The prefix of the provider ID of a program's fixes: `program:<id>@<version>`.
    const ProviderIdPrefix string = "program:"

    private let programs ImmutableArray[TransformationProgram]
    private let ids ImmutableArray[string]

    /// Initializes a new instance of the (cref:ProgramFixProvider) class.
    /// @param programs The programs, in the order that their fixes are offered.
    init(programs ImmutableArray[TransformationProgram]) {
        if programs.IsDefaultOrEmpty {
            throw ArgumentException("Give at least one program.", nameof(programs))
        }
        this.programs = programs
        ids = programs
            .SelectMany((p TransformationProgram) -> p.Trigger.DiagnosticIds)
            .Distinct(StringComparer.Ordinal)
            .OrderBy((id string) -> id, StringComparer.Ordinal)
            .ToImmutableArray()
    }

    /// Gets the programs.
    prop Programs ImmutableArray[TransformationProgram] -> programs

    override prop FixableDiagnosticIds ImmutableArray[string] -> ids

    override prop Id string -> "GSharp.CodeAnalysis.Transformations.ProgramFixProvider"

    override prop IsDataDefined bool -> true

    override func RegisterCodeFixes(context CodeFixContext) {
        let diagnostic = context.Diagnostic
        let anchor SyntaxToken? = context.Tree.Root.FindToken(diagnostic.Location.Span.Start)
        if anchor == nil {
            return
        }
        for program in programs {
            context.CancellationToken.ThrowIfCancellationRequested()
            if !Triggers(program.Trigger, diagnostic) {
                continue
            }
            let captures = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
            if !Match(program.Pattern, anchor, context.Tree, captures) {
                continue
            }
            if !program.Guards.All((g GuardPredicate) -> Holds(g, captures, context)) {
                continue
            }
            let tree = context.Tree
            let bound = Dictionary[string, SyntaxNode](captures, StringComparer.Ordinal)
            let current = program
            context.RegisterFix(
                CodeFix(
                    program.Title,
                    program.Id,
                    program.Applicability,
                    ImmutableArray.Create(diagnostic),
                    "${ProviderIdPrefix}${program.Id}@${program.Version}",
                    (ct CancellationToken) -> {
                        ct.ThrowIfCancellationRequested()
                        let editor = SyntaxEditor(tree)
                        for edit in current.Edits {
                            Apply(editor, edit, bound)
                        }
                        return FixChanges(
                            ImmutableArray.Create(DocumentChanges(tree, editor.GetChanges(), editor.GetPlaceholders()))
                        )
                    }
                )
            )
        }
    }

    private func Triggers(trigger ProgramTrigger, diagnostic Diagnostic) bool {
        if !trigger.DiagnosticIds.Contains(diagnostic.Id, StringComparer.Ordinal) {
            return false
        }
        if trigger.ArgumentIndex == nil {
            return true
        }
        let index = trigger.ArgumentIndex
        let arguments = diagnostic.MessageArguments
        return index >= 0 &&
            index < arguments.Length &&
            (trigger.ArgumentEquals == nil || arguments[index] == trigger.ArgumentEquals)
    }

    private func Match(
        pattern SyntaxPattern,
        node SyntaxNode,
        tree SyntaxTree,
        captures Dictionary[string, SyntaxNode]
    ) bool {
        if pattern.Kind != nil && node.Kind.ToString() != pattern.Kind {
            return false
        }
        if pattern.Text != nil && !(node is SyntaxToken token && token.Text == pattern.Text) {
            return false
        }
        if pattern.Capture != nil {
            captures[pattern.Capture] = node
        }
        let nextPattern SyntaxPattern? = pattern.Next
        if nextPattern != nil {
            let next SyntaxToken? = Neighbour(tree, node, true)
            if next == nil || !Follows(nextPattern, tree, node, next) || !Match(nextPattern, next, tree, captures) {
                return false
            }
        }
        let previousPattern SyntaxPattern? = pattern.Previous
        if previousPattern != nil {
            let previous SyntaxToken? = Neighbour(tree, node, false)
            if previous == nil ||
                !Follows(previousPattern, tree, node, previous) ||
                !Match(previousPattern, previous, tree, captures) {
                return false
            }
        }
        let ancestorPattern SyntaxPattern? = pattern.Ancestor
        if ancestorPattern != nil {
            let kind string? = ancestorPattern.Kind
            var current SyntaxNode? = node.Parent
            while current != nil && kind != nil && current.Kind.ToString() != kind {
                current = current.Parent
            }
            if current == nil ||
                !Follows(ancestorPattern, tree, node, current) ||
                !Match(ancestorPattern, current, tree, captures) {
                return false
            }
        }
        return true
    }

    private func Follows(
        pattern SyntaxPattern,
        tree SyntaxTree,
        from SyntaxNode,
        to SyntaxNode
    ) bool -> !pattern.SameLine ||
        tree.Text.GetLineIndex(from.Span.Start) == tree.Text.GetLineIndex(to.Span.Start)

    // The neighbouring real token whose text is the source text.
    private func Neighbour(tree SyntaxTree, node SyntaxNode, forward bool) SyntaxToken? {
        var best SyntaxToken? = nil
        let text = tree.Text
        for token in tree.Root.DescendantTokens() {
            if token.IsMissing || token.Span.Length == 0 || token.Span.End > text.Length || text.ToString(
                token.Span
            ) != token.Text {
                continue
            }
            if forward {
                if token.Span.Start >= node.Span.End && (best == nil || token.Span.Start < best.Span.Start) {
                    best = token
                }
            } else if token.Span.End <= node.Span.Start && (best == nil || token.Span.End > best.Span.End) {
                best = token
            }
        }
        return best
    }

    private func Holds(rule GuardPredicate, captures Dictionary[string, SyntaxNode], context CodeFixContext) bool {
        let node = captures[rule.Capture]
        let model = context.SemanticModel
        let ct = context.CancellationToken
        switch rule.Predicate {
            case "textEquals" {
                return context.Tree.Text.ToString(node.Span) == rule.Value
            }
            case "kindIs" {
                return node.Kind.ToString() == rule.Value
            }
            case "sameLine" {
                let other = captures[rule.Other ?? rule.Capture]
                return context
                    .Tree
                    .Text
                    .GetLineIndex(node.Span.Start) == context
                    .Tree
                    .Text
                    .GetLineIndex(other.Span.Start)
            }
            case "symbolKind" {
                return SymbolKindName(SymbolOf(model, node, ct)) == rule.Value
            }
            case "declaredWith" {
                return DeclarationKeyword(SymbolOf(model, node, ct)) == rule.Value
            }
            case "constructsReferenceType" {
                let call CallExpressionSyntax? = if node is CallExpressionSyntax c {
                    c
                } else {
                    context
                        .Tree
                        .Root
                        .DescendantNodes()
                        .OfType[CallExpressionSyntax]()
                        .FirstOrDefault((c CallExpressionSyntax) -> object.ReferenceEquals(c.Identifier, node))
                }
                // An indirect call (`(f)()`) invokes a value, never a constructor.
                if call == nil || call.Callee != nil || model.GetSymbolInfo(call, ct).Symbol != nil {
                    return false
                }
                let type = model.GetTypeInfo(call, ct).Type
                if type == nil || type.IsValueType {
                    return false
                }
                // A call of a function value (`make()` with a parameter `make () -> C`) has no
                // symbol either. The callee's name must name only types or type aliases in scope.
                let callee = call.Identifier
                return !model.LookupSymbols(call.Span.Start, callee.ValueText, ct).Any(
                    (s Symbol) -> !(s is TypeSymbol || s is TypeAliasSymbol)
                )
            }
            case "typeIs" {
                return TypeOf(model, node, ct)?.ToString() == rule.Value
            }
            case "isNullable" {
                // The type itself is nullable, not an element or argument of it.
                return TypeOf(model, node, ct) is NullableTypeSymbol
            }
            default {
                return false
            }
        }
    }

    // The symbol of a capture: GetSymbolInfo of its node, else the one symbol that its name finds
    // in scope. The fallback covers the code the semantic model does not answer for: an argument
    // the binder never bound, such as a function literal argument of a call that fails before the
    // literal gets a target type (#6149, #6150 and #6151 closed the other gaps).
    private func SymbolOf(model SemanticModel, node SyntaxNode, ct CancellationToken) Symbol? {
        // An identifier token answers its own symbol: a declared parameter, or the variable of a
        // called function value rather than the call's member. Another token asks its parent.
        let target SyntaxNode? = if node is SyntaxToken{Kind: SyntaxKind.IdentifierToken} {
            node
        } else if node is SyntaxToken {
            node.Parent
        } else {
            node
        }
        if target == nil {
            return nil
        }
        let bound Symbol? = model.GetSymbolInfo(target, ct).Symbol
        if bound != nil {
            return bound
        }
        // A member name after a dot names a member of its receiver, never a variable in scope.
        if IsMemberName(node) {
            return nil
        }
        // The semantic name: `$c` names `c`.
        let name string? = switch node {
            case token is SyntaxToken when token.Kind == SyntaxKind.IdentifierToken: token.ValueText
            case nameExpression is NameExpressionSyntax: nameExpression.IdentifierToken.ValueText
            default: default(string?)
        }
        if name == nil {
            return nil
        }
        let found = model.LookupSymbols(node.Span.Start, name, ct)
        return if found.Length == 1 {
            found[0]
        } else {
            default(Symbol?)
        }
    }

    // Whether a capture is the name of a member access (`N` in `c.N`, `M` in `c.M()`).
    // In a chain, a name is a member name when it lies in the right part of any enclosing access:
    // `b` in `a.b.c` is, whichever way the parser nests the chain.
    private func IsMemberName(node SyntaxNode) bool {
        var current SyntaxNode? = if node is SyntaxToken {
            node.Parent
        } else {
            node
        }
        while current?.Parent is AccessorExpressionSyntax access {
            if !object.ReferenceEquals(access.LeftPart, current) {
                return true
            }
            current = access
        }
        return false
    }

    // The type of a capture: GetTypeInfo of its node, else the type of its variable. An identifier
    // token asks about itself first; the callee of a call is not the call, whose type is the result.
    private func TypeOf(model SemanticModel, node SyntaxNode, ct CancellationToken) TypeSymbol? {
        if node is SyntaxToken{Kind: SyntaxKind.IdentifierToken} {
            let own TypeSymbol? = model.GetTypeInfo(node, ct).Type
            if own != nil {
                return own
            }
        }
        let target SyntaxNode? = if node.Parent is CallExpressionSyntax call && object.ReferenceEquals(
            call.Identifier,
            node
        ) {
            nil
        } else if node is SyntaxToken {
            node.Parent
        } else {
            node
        }
        let bound TypeSymbol? = if target == nil {
            nil
        } else {
            model.GetTypeInfo(target, ct).Type
        }
        if bound != nil {
            return bound
        }
        return switch SymbolOf(model, node, ct) {
            case variable is VariableSymbol: variable.Type
            case field is FieldSymbol: field.Type
            case property is PropertySymbol: property.Type
            default: default(TypeSymbol?)
        }
    }

    private func SymbolKindName(symbol Symbol?) string? -> switch symbol {
        case nil: default(string?)
        case p is ParameterSymbol: "parameter"
        case l is LocalVariableSymbol: "local"
        case f is FieldSymbol: "field"
        case fn is FunctionSymbol: "function"
        case t is TypeSymbol: "type"
        default: "other"
    }

    private func DeclarationKeyword(symbol Symbol?) string? {
        if symbol == nil || symbol is ParameterSymbol {
            return nil
        }
        for declaration in symbol.DeclaringSyntaxNodes {
            let owner = if declaration is SyntaxToken {
                declaration.Parent
            } else {
                declaration
            }
            switch owner {
                case local is VariableDeclarationSyntax {
                    return local.Keyword?.Text
                }
                case field is FieldDeclarationSyntax {
                    return field.VarOrLetKeyword?.Text
                }
            }
        }
        return nil
    }

    private func Apply(editor SyntaxEditor, edit EditOperation, captures Dictionary[string, SyntaxNode]) {
        let node = captures[edit.Capture]
        let text = Expand(editor, edit.Template ?? string.Empty, captures)
        switch edit.Kind {
            case EditOperationKind.Replace {
                if node is SyntaxToken token {
                    editor.ReplaceToken(token, text)
                } else {
                    editor.ReplaceNode(node, text)
                }
            }
            case EditOperationKind.Delete {
                if node is SyntaxToken token {
                    editor.RemoveToken(token)
                } else {
                    editor.RemoveNode(node)
                }
            }
            case EditOperationKind.InsertBefore {
                editor.InsertBefore(node, text)
            }
            case EditOperationKind.InsertAfter {
                editor.InsertAfter(node, text)
            }
        }
    }

    // `${name}` takes the source text of the capture; `$$` is a literal `$`.
    private func Expand(editor SyntaxEditor, template string, captures Dictionary[string, SyntaxNode]) string {
        let builder = StringBuilder()
        var i = 0
        while i < template.Length {
            if template[i] == '$' && i + 1 < template.Length && template[i + 1] == '$' {
                builder.Append('$')
                i += 2
                continue
            }
            if template[i] == '$' && i + 1 < template.Length && template[i + 1] == '{' {
                let end = template.IndexOf('}', i + 2)
                if end < 0 {
                    throw FormatException("Unclosed slot in the template '${template}'.")
                }
                let name = template.Substring(i + 2, end - i - 2)
                if !captures.TryGetValue(name, out var node) {
                    throw FormatException("The template names the unknown capture '${name}'.")
                }
                builder.Append(editor.OriginalText(node))
                i = end + 1
                continue
            }
            builder.Append(template[i])
            i++
        }
        return builder.ToString()
    }
}
