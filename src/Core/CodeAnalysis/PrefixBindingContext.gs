// <copyright file="PrefixBindingContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Threading

/// The kind of a failed lookup that a report states (ADR-0225).
internal enum PrefixLookupKind {
    /// A simple name: a variable, a function or a type.
    Name,
    /// A member of a receiver or of a type.
    Member
}

/// The callee of a call whose resolution the binder reports on in a prefix bind (ADR-0225 D6.5).
internal enum PrefixCallKind {
    /// A simple name: a later declaration can add a candidate or hide the callee.
    Name,
    /// A member of a receiver or of a type: a later member or receiver function can add a candidate.
    Member,
    /// A local or a parameter of a function type. No later text can change its signature.
    Fixed,
    /// A function literal or lambda body inside a call. The body states its own calls.
    Body
}

/// The facts of a prefix tree that the binder reads when it reports (ADR-0225).
/// The parser records them when it seals the cut. They are null for a tree of a complete program.
internal sealed class PrefixCut {
    internal init(
        text SourceText,
        cut int32,
        remainder PrefixRemainder,
        keptStart int32,
        laterDeclarationsPossible bool,
        openMemberStart int32,
        sealedTokens ImmutableArray[SyntaxToken]
    ) {
        Text = text
        Cut = cut
        Remainder = remainder
        KeptStart = keptStart
        LaterDeclarationsPossible = laterDeclarationsPossible
        OpenMemberStart = openMemberStart
        SealedTokens = sealedTokens
    }

    /// Gets the tokens that close the delimiters that are open at the cut, innermost first.
    internal prop SealedTokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the text of the prefix tree.
    internal prop Text SourceText {
        get;
    }

    /// Gets the cut position.
    internal prop Cut int32 {
        get;
    }

    /// Gets what follows the cut.
    internal prop Remainder PrefixRemainder {
        get;
    }

    /// Gets the position of the first token after the cut that the prefix tree keeps.
    /// The text from (cref:Cut) to this position is not in the tree.
    internal prop KeptStart int32 {
        get;
    }

    /// Gets a value that tells whether a declaration after the cut can declare a name that any scope sees.
    /// This is true when nothing follows the cut, and when the cut is in the top-level statements.
    internal prop LaterDeclarationsPossible bool {
        get;
    }

    /// Gets the start of the member whose text after the cut the bind removed, or -1.
    internal prop OpenMemberStart int32 {
        get;
    }

    /// Returns a value that tells whether [`location`](paramref) is in the text that the bind removed.
    /// @param location A diagnostic location.
    /// @returns `true` for a location from the cut to the first kept token.
    internal func IsRemoved(location TextLocation) bool {
        if !object.ReferenceEquals(location.Text, Text) || location.Span.Start < Cut {
            return false
        }
        // When nothing follows the cut or nothing is kept, everything at or after the cut is removed,
        // also when the text ends there.
        return Remainder == PrefixRemainder.Nothing || !HasKeptText || location.Span.Start < KeptStart
    }

    /// Gets or sets the lexer diagnostics of tokens that the cut left unfinished (an unterminated string
    /// or comment). The lexer states them when it reaches the end of its input.
    internal prop UnfinishedTokenDiagnostics ImmutableArray[Diagnostic] {
        get {
            return if unfinishedTokenDiagnostics.IsDefault {
                ImmutableArray[Diagnostic].Empty
            } else {
                unfinishedTokenDiagnostics
            }
        }
        set {
            unfinishedTokenDiagnostics = value
        }
    }

    private var unfinishedTokenDiagnostics ImmutableArray[Diagnostic]

    /// Gets or sets the span of the last source token before the cut, or an empty span at 0.
    internal prop LastToken TextSpan {
        get;
        set;
    }

    /// Gets or sets a value that tells whether the last source token before the cut is a word (a name,
    /// a keyword or a number) that more text after the cut can extend.
    internal prop LastTokenIsWord bool {
        get;
        set;
    }

    /// Gets or sets a value that tells whether the prefix tree keeps text after the cut.
    internal prop HasKeptText bool {
        get;
        set;
    }

    /// Gets the prefix tree. The parser sets it after the parse.
    internal prop Tree SyntaxTree? {
        get;
        set;
    }

    /// Returns a value that tells whether [`location`](paramref) is in a function literal or a lambda of
    /// the open member before the cut. Such a body can use a local that a later statement declares. When
    /// nothing follows the cut, a literal of any member before the cut counts.
    /// @param location A diagnostic location.
    /// @returns `true` when a later statement of the open member can declare a name that the location sees.
    internal func IsInDeferredBodyOfOpenMember(location TextLocation) bool {
        // When nothing follows the cut, any member before the cut can be the open one.
        let memberStart = if Remainder == PrefixRemainder.Nothing {
            0
        } else {
            OpenMemberStart
        }
        if memberStart < 0 || !object.ReferenceEquals(location.Text, Text) || Tree is not{} tree {
            return false
        }
        let position = location.Span.Start
        if position < memberStart || position >= Cut {
            return false
        }
        var node SyntaxNode = tree.Root
        while true {
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                if child.Span.Start <= position && position < child.Span.End {
                    next = child
                    break
                }
            }
            if next == nil {
                return false
            }
            if next
                .Span
                .Start >= memberStart &&
                (next is LambdaExpressionSyntax || next is FunctionLiteralExpressionSyntax) {
                return true
            }
            node = next
        }
        return false
    }
}

/// A premise that the binder states when it reports a diagnostic in a prefix bind (ADR-0225).
internal sealed class PrefixPremise {
    internal init(finality DiagnosticFinality, reason string) {
        Finality = finality
        Reason = reason
    }

    /// Gets the finality of the diagnostics that the premise covers.
    internal prop Finality DiagnosticFinality {
        get;
    }

    /// Gets the reason, or an empty string for a final diagnostic.
    internal prop Reason string {
        get;
    }

    shared {
        /// Gets the premise of a failed simple-name lookup: a later declaration can declare the name.
        internal let LaterDeclaration PrefixPremise = PrefixPremise(
            DiagnosticFinality.FutureDependent,
            "later-declaration"
        )

        /// Gets the premise of a failed member lookup: a later declaration can declare the member.
        internal let LaterMember PrefixPremise = PrefixPremise(DiagnosticFinality.FutureDependent, "later-member")

        /// Gets the premise of a check at the end of an open body.
        internal let RestOfBody PrefixPremise = PrefixPremise(DiagnosticFinality.FutureDependent, "rest-of-body")

        /// Gets the premise of a check of an open type.
        internal let RestOfType PrefixPremise = PrefixPremise(DiagnosticFinality.FutureDependent, "rest-of-type")

        /// Gets the premise of a check of a statement that is open at the cut.
        internal let RestOfStatement PrefixPremise = PrefixPremise(
            DiagnosticFinality.FutureDependent,
            "rest-of-statement"
        )
    }
}

/// The prefix cut that a compilation binds under (ADR-0225). Binding reads it from an ambient value, as
/// it reads (cref:Symbols.NullabilityOptions), because a failed lookup in any tree can depend on a
/// declaration after the cut.
internal shared class PrefixBindingContext {
    private let current AsyncLocal[PrefixCut?] = AsyncLocal[PrefixCut?]()

    /// Restores the previous prefix cut.
    internal struct Scope : IDisposable {
        private let previous PrefixCut?

        internal init(previous PrefixCut?) {
            this.previous = previous
        }

        /// Restores the previous prefix cut.
        func Dispose() {
            PrefixBindingContext.current.Value = this.previous
        }
    }

    /// Gets the prefix cut of the bind in progress, or `null`.
    internal prop Current PrefixCut? -> current.Value

    /// Sets the prefix cut of the bind in progress until the scope ends.
    /// @param cut The prefix cut, or `null` for a complete program.
    /// @returns The scope that restores the previous value.
    internal func Enter(cut PrefixCut?) PrefixBindingContext.Scope {
        let previous = current.Value
        current.Value = cut
        return PrefixBindingContext.Scope(previous)
    }

    /// Returns the premise of a failed lookup at [`location`](paramref), or `null` when the failure is final.
    /// @param location The location of the failed lookup.
    /// @param kind The kind of the failed lookup.
    /// @returns The finality and its reason, or `null`.
    internal func ClassifyFailedLookup(location TextLocation, kind PrefixLookupKind) PrefixPremise? {
        if current.Value is not{} cut {
            return nil
        }
        // A simple-name lookup ends in the file scope. A member lookup can find a member of an open or
        // partial type, or a receiver function (`func (v T) Name()`), that a later declaration adds.
        if kind == PrefixLookupKind.Member {
            // The kept declarations hold every member and receiver function after the cut.
            return if cut.Remainder == PrefixRemainder.Nothing {
                PrefixPremise.LaterMember
            } else {
                nil
            }
        }
        if cut.LaterDeclarationsPossible {
            return PrefixPremise.LaterDeclaration
        }
        // A function literal can use a local that a later statement declares.
        if kind == PrefixLookupKind.Name && cut.IsInDeferredBodyOfOpenMember(location) {
            return PrefixPremise.LaterDeclaration
        }
        return nil
    }

    /// Gets a value that tells whether a top-level statement can follow the cut of the bind in progress:
    /// nothing follows the cut, or the cut is in the top-level statements.
    internal prop TopLevelStatementsCanFollow bool -> current.Value is {} cut && cut.LaterDeclarationsPossible

    /// Returns a value that tells whether a later declaration can add a conversion between
    /// [`fromType`](paramref) and [`toType`](paramref) (ADR-0120): nothing follows the cut, and one of
    /// the types is a type of this compilation, or an imported type that a later source type of the same
    /// name can hide (D6.3). A built-in type is neither.
    /// @param fromType The source type of the conversion.
    /// @param toType The target type of the conversion.
    /// @returns `true` when a later `func operator implicit` can remove a missing-conversion report.
    internal func LaterConversionCanFollow(fromType TypeSymbol, toType TypeSymbol) bool {
        if current.Value is not{} cut || cut.Remainder != PrefixRemainder.Nothing {
            return false
        }
        return IsSourceType(fromType) || IsSourceType(toType)
    }

    private func IsSourceType(type TypeSymbol) bool {
        // The nullability carriers wrap the type that a conversion is declared for.
        var underlying = type
        for var depth = 0; depth < 8; depth++ {
            if underlying is NullableTypeSymbol nullable {
                underlying = nullable.UnderlyingType
            } else if underlying is PlatformTypeSymbol platform {
                underlying = platform.UnderlyingType
            } else if underlying is NullabilityAnnotatedTypeSymbol annotated {
                underlying = annotated.BaseType
            } else {
                break
            }
        }
        return (underlying is StructSymbol structSymbol && structSymbol.Declaration != nil) ||
            underlying is ImportedTypeSymbol
    }

    /// Returns the premise of a failed overload resolution or argument check at [`location`](paramref)
    /// (ADR-0225 D6.5), or `null` when the failure is final. A later declaration can add a candidate.
    /// @param location The location of the report.
    /// @param kind The callee of the call.
    /// @returns The finality and its reason, or `null`.
    internal func ClassifyCallResolution(location TextLocation, kind PrefixCallKind) PrefixPremise? {
        // A function literal of the open member can call a local that a later statement declares.
        return if kind == PrefixCallKind.Fixed {
            if current.Value is {} cut && cut.IsInDeferredBodyOfOpenMember(location) {
                PrefixPremise.LaterDeclaration
            } else {
                default(PrefixPremise?)
            }
        } else if kind == PrefixCallKind.Member {
            ClassifyFailedLookup(location, PrefixLookupKind.Member)
        } else {
            ClassifyFailedLookup(location, PrefixLookupKind.Name)
        }
    }

    /// Returns a value that tells whether the type of [`value`](paramref) comes from the parameter that
    /// it fills, so that a diagnostic inside it can depend on the candidate (ADR-0225 D6.5).
    /// @param value An argument expression.
    /// @returns `false` for an expression that has a type of its own.
    internal func IsTypedByCandidate(value ExpressionSyntax) bool {
        var current = value
        while current is ParenthesizedExpressionSyntax parenthesized {
            current = parenthesized.Expression
        }
        if current is BinaryExpressionSyntax binary {
            return binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken
        }
        if current is LiteralExpressionSyntax literal {
            return literal.LiteralToken.Kind == SyntaxKind.NilKeyword
        }
        return !(
            current is NameExpressionSyntax ||
                current is GenericNameExpressionSyntax ||
                current is AccessorExpressionSyntax ||
                current is CallExpressionSyntax ||
                current is UnaryExpressionSyntax ||
                current is InterpolatedStringExpressionSyntax ||
                current is TypeOfExpressionSyntax ||
                current is SizeOfExpressionSyntax ||
                current is NameOfExpressionSyntax ||
                current is IsExpressionSyntax ||
                current is AsExpressionSyntax ||
                current is ObjectCreationExpressionSyntax ||
                current is ArrayCreationExpressionSyntax ||
                current is AwaitExpressionSyntax ||
                current is IndexExpressionSyntax ||
                current is RefArgumentExpressionSyntax
        )
    }

    /// Returns a value that tells whether [`node`](paramref) is open at the cut: its last token is a
    /// closing token that the parser added at the cut.
    /// @param node A syntax node, or `null`.
    /// @returns `true` for an open node of a prefix tree. It is `false` for every node of a complete program.
    internal func IsOpen(node SyntaxNode?) bool {
        if node == nil || node.SyntaxTree.Prefix is not{} cut || node.Span.End != cut.Cut {
            return false
        }
        var current SyntaxNode = node
        while current is not SyntaxToken {
            let count = current.ChildCount
            if count == 0 {
                return false
            }
            current = current.GetChild(count - 1)
        }
        return cast[SyntaxToken](current).IsSealedAtCut
    }

    /// Returns a value that tells whether a type can still get members after the cut: it is open at the
    /// cut, one of its partial parts is open, or it is partial and nothing follows the cut.
    /// @param syntax A type declaration. For a partial type it is the node that merges the parts.
    /// @returns `true` when a later declaration can add a member to the type.
    internal func IsIncompleteType(syntax StructDeclarationSyntax) bool {
        if IsOpen(syntax) {
            return true
        }
        if !syntax.IsPartial || current.Value is not{} cut {
            return false
        }
        if cut.Remainder == PrefixRemainder.Nothing {
            return true
        }
        if cut.Tree is not{} tree {
            return false
        }
        for part in syntax.PartialPartLocations {
            if object.ReferenceEquals(part.Text, cut.Text) && IsOpen(TypeDeclarationAt(tree, part.Span.Start)) {
                return true
            }
        }
        return false
    }

    // The innermost type declaration of [`tree`](paramref) that contains [`position`](paramref).
    private func TypeDeclarationAt(tree SyntaxTree, position int32) StructDeclarationSyntax? {
        var found StructDeclarationSyntax? = nil
        var node SyntaxNode = tree.Root
        while true {
            if node is StructDeclarationSyntax declaration {
                found = declaration
            }
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                if child.Span.Start <= position && position < child.Span.End {
                    next = child
                    break
                }
            }
            if next == nil {
                return found
            }
            node = next
        }
        return found
    }

    /// Returns a value that tells whether [`node`](paramref) is the last construct before the cut: it
    /// ends at or before the cut and no later token of its parent starts before the cut. A clause of the
    /// construct (a `catch` after a `try` block) can still follow.
    /// @param node A syntax node, or `null`.
    /// @returns `true` for the last construct before the cut of a prefix tree.
    internal func IsLastBeforeCut(node SyntaxNode?) bool {
        if node == nil || node.SyntaxTree.Prefix is not{} cut || node.Span.End > cut.Cut {
            return false
        }
        var current SyntaxNode = node
        while node.SyntaxTree.GetParent(current) is {} parent {
            var after = false
            for sibling in parent.GetChildren() {
                if object.ReferenceEquals(sibling, current) {
                    after = true
                } else if after &&
                    sibling
                    .Span
                    .Start < cut.Cut &&
                    !(sibling is SyntaxToken token && token.IsSealedAtCut) {
                    return false
                }
            }
            if parent.Span.End > cut.Cut || IsOpen(parent) {
                return true
            }
            current = parent
        }
        return true
    }

    /// Returns a value that tells whether [`node`](paramref) or one of its ancestors of kind
    /// [`kind`](paramref) is open at the cut.
    /// @param node A syntax node, or `null`.
    /// @param kind The kind of the ancestor.
    /// @returns `true` when the nearest node of that kind is open.
    internal func IsInOpen(node SyntaxNode?, kind SyntaxKind) bool {
        if node == nil || node.SyntaxTree.Prefix == nil {
            return false
        }
        var current SyntaxNode? = node
        while current != nil {
            if current.Kind == kind {
                return IsOpen(current)
            }
            current = node.SyntaxTree.GetParent(current)
        }
        return false
    }

    /// Returns a value that tells whether [`token`](paramref) closes a construct that is open at the cut.
    /// @param token A closing token, or `null`.
    /// @returns `true` for a token that the parser added at the cut.
    internal func IsSealed(token SyntaxToken?) bool -> token != nil && token.IsSealedAtCut
}
