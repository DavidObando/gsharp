// <copyright file="PrefixDiagnosticClassifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Threading

/// Gives each diagnostic of a prefix bind its finality (ADR-0225).
/// @remarks The binder stamps a premise when it reports a diagnostic. This class adds the facts that
/// only the parse and the source tree know: text that the bind removed, and parse diagnostics that
/// the seal caused. A diagnostic without a premise is final.
internal sealed class PrefixDiagnosticClassifier {
    private let source Compilation
    private let sourceTree SyntaxTree
    private let prefixCut PrefixCut
    private let cancellationToken CancellationToken
    private let prefixTree SyntaxTree
    private let prefixModel Func[SemanticModel]
    private let prefixParse HashSet[Diagnostic]
    private let unfinishedTokens HashSet[Diagnostic]
    private var sourceParse HashSet[string]?
    private var sourceDiagnostics HashSet[string]?

    internal init(
        source Compilation,
        sourceTree SyntaxTree,
        prefixTree SyntaxTree,
        prefixCut PrefixCut,
        prefixModel Func[SemanticModel],
        cancellationToken CancellationToken
    ) {
        this.prefixModel = prefixModel
        this.source = source
        this.sourceTree = sourceTree
        this.prefixCut = prefixCut
        this.prefixTree = prefixTree
        this.cancellationToken = cancellationToken
        prefixParse = HashSet[Diagnostic](prefixTree.Diagnostics, ReferenceEqualityComparer.Instance)
        unfinishedTokens = HashSet[Diagnostic](prefixCut.UnfinishedTokenDiagnostics, ReferenceEqualityComparer.Instance)
    }

    /// Returns the classified form of [`diagnostic`](paramref).
    /// @param diagnostic A diagnostic of the prefix compilation.
    /// @returns The diagnostic with its finality.
    internal func Classify(diagnostic Diagnostic) ClassifiedDiagnostic {
        let location = diagnostic.Location
        if prefixCut.IsRemoved(location) {
            return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.Artifact, "cut")
        }
        let inPrefixText = object.ReferenceEquals(location.Text, prefixCut.Text)
        // The lexer reached the cut inside this token (an unterminated string or comment). Text after the
        // cut can finish the token.
        if unfinishedTokens.Contains(diagnostic) {
            return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.Artifact, "cut")
        }
        // A diagnostic that ends with a name, keyword or number at the cut depends on its spelling, and
        // text after the cut can extend the word. With kept text, that happens only when the word goes on.
        if inPrefixText &&
            diagnostic.PrefixFinality == DiagnosticFinality.Final &&
            location
            .Span
            .End == prefixCut.Cut &&
            prefixCut.LastTokenIsWord &&
            prefixCut
            .LastToken
            .End == prefixCut.Cut &&
            WordContinuesAfterCut() {
            return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.FutureDependent, "rest-of-statement")
        }
        // The tokens before the cut are the same in both parses. A parse diagnostic that the source tree
        // does not report there comes from the closing tokens at the cut.
        if inPrefixText && prefixParse.Contains(diagnostic) && location.Span.Start < prefixCut.Cut {
            if sourceParse == nil {
                sourceParse = Keys(sourceTree.Diagnostics)
            }
            if !sourceParse!!.Contains(Key(diagnostic)) {
                return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.Artifact, "cut")
            }
        }
        // A diagnostic on a construct that is open at the cut (a call whose argument list the seal
        // closed) depends on the rest of the construct.
        if inPrefixText &&
            diagnostic.PrefixFinality == DiagnosticFinality.Final &&
            location
            .Span
            .Start < prefixCut.Cut &&
            location
            .Span
            .End == prefixCut.Cut &&
            IsOnOpenConstruct(location.Span) {
            return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.FutureDependent, "rest-of-statement")
        }
        // Kept text after the cut can depend on the text that the bind removed. The source compilation
        // is a completion of the prefix, so a diagnostic that it does not report is not final.
        if inPrefixText &&
            location
            .Span
            .Start >= prefixCut.KeptStart &&
            diagnostic.PrefixFinality == DiagnosticFinality
            .Final {
            if sourceDiagnostics == nil {
                sourceDiagnostics = Keys(source.GetDiagnostics(cancellationToken))
            }
            if !sourceDiagnostics!!.Contains(Key(diagnostic)) {
                return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.FutureDependent, "rest-of-body")
            }
        }
        // ADR-0225 D6.5: the chosen candidate of a call types a function literal argument and converts each
        // argument. A later candidate can change both. It cannot change a parse diagnostic.
        if inPrefixText && diagnostic.PrefixFinality == DiagnosticFinality.Final && !prefixParse.Contains(diagnostic) &&
            location
            .Span
            .End <= prefixCut.Cut &&
            ArgumentPremise(location.Span) is {} argumentPremise {
            return ClassifiedDiagnostic(diagnostic, argumentPremise.Finality, argumentPremise.Reason)
        }
        return ClassifiedDiagnostic(diagnostic, diagnostic.PrefixFinality, diagnostic.PrefixReason)
    }

    // ADR-0225 D6.5: the premise of a call that has a diagnostic at [`span`](paramref) in one of its
    // arguments: the diagnostic is the conversion of the argument, or it is in an argument that the
    // candidate types (a function literal, `nil`, a collection). Null when no such call can get a candidate.
    private func ArgumentPremise(span TextSpan) PrefixPremise? {
        let path = List[SyntaxNode]()
        var node SyntaxNode = prefixTree.Root
        while true {
            path.Add(node)
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                let childSpan = child.Span
                if childSpan.Length > 0 && childSpan.Start <= span.Start && span.End <= childSpan.End {
                    next = child
                    break
                }
            }
            if next == nil {
                break
            }
            node = next
        }
        for var index = path.Count - 1; index >= 1; index-- {
            let argument = path[index]
            let call = path[index - 1]
            let arguments = if call is CallExpressionSyntax callExpression {
                callExpression.Arguments
            } else if call is BaseInterfaceCallExpressionSyntax baseInterfaceCall {
                baseInterfaceCall.Arguments
            } else {
                continue
            }
            var isArgument = false
            for candidate in arguments {
                if object.ReferenceEquals(candidate, argument) {
                    isArgument = true
                    break
                }
            }
            if !isArgument {
                continue
            }
            let value = if argument is NamedArgumentExpressionSyntax named {
                named.Expression
            } else {
                cast[ExpressionSyntax](argument)
            }
            let isConversion = (argument.Span.Start == span.Start && argument.Span.End == span.End) ||
                (value.Span.Start == span.Start && value.Span.End == span.End)
            if !isConversion && !IsTypedByCandidate(value) {
                continue
            }
            let parent = if index >= 2 {
                path[index - 2]
            } else {
                default(SyntaxNode?)
            }
            if PrefixBindingContext.ClassifyCallResolution(
                TextLocation(prefixCut.Text, span),
                CallKind(call, parent)
            ) is {} premise {
                return premise
            }
        }
        return nil
    }

    // The callee of a call in the prefix tree, for (cref:PrefixBindingContext.ClassifyCallResolution).
    private func CallKind(call SyntaxNode, parent SyntaxNode?) PrefixCallKind {
        if call is BaseInterfaceCallExpressionSyntax || parent is BaseClassCallExpressionSyntax {
            return PrefixCallKind.Member
        }
        if parent is AccessorExpressionSyntax accessor && object.ReferenceEquals(accessor.RightPart, call) {
            return PrefixCallKind.Member
        }
        if call is CallExpressionSyntax simple && simple.Callee == nil && !simple.Identifier.IsMissing {
            // No later text changes the signature of a local or a parameter.
            if prefixModel().GetSymbolInfo(simple.Identifier, cancellationToken).Symbol is LocalVariableSymbol {
                return PrefixCallKind.Fixed
            }
        }
        return PrefixCallKind.Name
    }

    // Returns true when the type of [`value`](paramref) comes from the parameter that it fills, so that
    // a diagnostic inside it can depend on the candidate. An expression with a type of its own returns false.
    private func IsTypedByCandidate(value ExpressionSyntax) bool {
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

    private func WordContinuesAfterCut() bool {
        if prefixCut.Remainder == PrefixRemainder.Nothing {
            return true
        }
        let text = prefixCut.Text
        return prefixCut.Cut < text.Length && PrefixTokenStream.IsWordCharacter(text[prefixCut.Cut])
    }

    // Returns true when a node with exactly this span is open at the cut.
    private func IsOnOpenConstruct(span TextSpan) bool {
        var node SyntaxNode = prefixTree.Root
        while true {
            if node.Span.Start == span.Start && node.Span.End == span.End && PrefixBindingContext.IsOpen(node) {
                return true
            }
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                let childSpan = child.Span
                if childSpan.Start <= span.Start && span.End <= childSpan.End && childSpan.Length > 0 {
                    next = child
                    break
                }
            }
            if next == nil {
                return false
            }
            node = next
        }
        return false
    }

    private func Keys(diagnostics IEnumerable[Diagnostic]) HashSet[string] {
        let keys = HashSet[string](StringComparer.Ordinal)
        for diagnostic in diagnostics {
            keys.Add(Key(diagnostic))
        }
        return keys
    }

    private func Key(diagnostic Diagnostic) string -> diagnostic.Id +
        "@" +
        diagnostic
        .Location
        .Span
        .Start
        .ToString() +
        ":" +
        diagnostic
        .Location
        .Span
        .Length
        .ToString()
}
