// <copyright file="NullabilityCodeFixProviders.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// GS0158 on a member of a nullable receiver: `.` → `?.` (ADR-0099, moved to Core by ADR-0227 D7).
/// @remarks The semantic model must give the receiver a nullable type. Where it has no answer (a
/// function literal body, #6149; an argument of a failed call, #6150), the receiver must look nullable from the
/// syntax: a `?.` chain, a `nil` literal, or a name whose declared type clause ends with `?`. The
/// fix changes the result type, so it is
/// (cref:Applicability.MaybeIncorrect).
internal class NullConditionalAccessCodeFixProvider : GSharpCodeFixProvider {
    /// The title of the fix.
    const Title string = "Use null-conditional access '?.'"

    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0158")

    override prop Id string -> "GSharp.CodeFixes.NullConditionalAccess"

    override func RegisterCodeFixes(context CodeFixContext) {
        let accessor AccessorExpressionSyntax? = FindAccessorAtRightPart(
            context.Tree.Root,
            context.Diagnostic.Location.Span
        )
        if accessor == nil || accessor.IsNullConditional || !FixSyntax.IsReal(accessor.DotToken) {
            return
        }
        // GS0158 also reports a member that does not exist; `?.` fixes only a member of a receiver
        // that may be nil.
        let message = if context.Diagnostic.MessageArguments.IsEmpty {
            context.Diagnostic.Message
        } else {
            context.Diagnostic.MessageArguments[0]
        }
        if !message.Contains("may be nil", StringComparison.Ordinal) {
            return
        }
        // `?.` reads a member. An assignment target (`c.N += 1`, `c.Child.N += 1`, `c.N ??= 1`) is
        // a write, where `?.` is not valid.
        if IsAssignmentTarget(accessor) {
            return
        }
        // The receiver's type decides (#6127). The model has no answer inside a function literal
        // (#6149) or in an argument of a call that fails too (#6150); there the syntax decides.
        let model = context.SemanticModel
        let receiverType = model.GetReceiverTypeInfo(accessor.LeftPart, context.CancellationToken).Type ??
            model.GetTypeInfo(accessor.LeftPart, context.CancellationToken).Type
        let nullable = if receiverType != nil {
            receiverType is NullableTypeSymbol
        } else {
            NullabilitySyntax.ReceiverLooksNullable(context.Tree, accessor.LeftPart)
        }
        if !nullable {
            return
        }
        let dot = accessor.DotToken
        context.RegisterFix(
            Title,
            "GS0158.NullConditionalAccess",
            Applicability.MaybeIncorrect,
            (editor SyntaxEditor) -> editor.ReplaceToken(dot, "?.")
        )
    }

    // Whether the access, or a chain, parentheses or indexing around it, is written: the target of a
    // compound or null-coalescing assignment, the receiver of a member write (`c.Child.N = 1`), or
    // the indexed target of an index write (`c.Items[0] = 1`), or a target of a multi-assignment
    // (`c.N, x = 1, 2`), and the storage of an indirect write (`*c.P = 1`). A right-hand value and an index
    // argument are reads.
    private func IsAssignmentTarget(accessor AccessorExpressionSyntax) bool {
        var current SyntaxNode = accessor
        while true {
            let parent = current.Parent
            // A chain that contains the access, on either side, writes through it when the chain is
            // written (`c.Tag.N += 1` however the chain nests).
            if parent is AccessorExpressionSyntax outer {
                current = outer
            } else if parent is ParenthesizedExpressionSyntax {
                current = parent
            } else if parent is IndexExpressionSyntax indexed && object.ReferenceEquals(indexed.Target, current) {
                current = indexed
            } else if parent is UnaryExpressionSyntax dereference &&
                dereference.OperatorToken.Kind == SyntaxKind.StarToken {
                current = dereference
            } else {
                break
            }
        }
        return switch current.Parent {
            case compound is EventSubscriptionExpressionSyntax: object.ReferenceEquals(compound.LeftHandSide, current)
            case coalescing is NullCoalescingAssignmentExpressionSyntax: object.ReferenceEquals(
                coalescing.Target,
                current
            )
            case member is MemberFieldAssignmentExpressionSyntax: object.ReferenceEquals(member.Receiver, current)
            case index is MemberIndexAssignmentExpressionSyntax: object.ReferenceEquals(index.Target, current)
            case compoundIndex is CompoundIndexAssignmentExpressionSyntax: object.ReferenceEquals(
                compoundIndex.Target,
                current
            )
            case indirect is IndirectAssignmentExpressionSyntax: object.ReferenceEquals(indirect.Target, current)
            case indirectCompound is IndirectCompoundAssignmentExpressionSyntax: object.ReferenceEquals(
                indirectCompound.Target,
                current
            )
            case multi is MultiAssignmentStatementSyntax: multi.Targets.Any(
                (target ExpressionSyntax) -> object.ReferenceEquals(target, current)
            )
            default: false
        }
    }

    // The smallest accessor whose right part covers the span. GS0158 is reported at the member name.
    private func FindAccessorAtRightPart(root SyntaxNode, span TextSpan) AccessorExpressionSyntax? {
        var best AccessorExpressionSyntax? = nil
        for accessor in root.DescendantNodesAndSelf().OfType[AccessorExpressionSyntax]() {
            let right = accessor.RightPart.Span
            if !(right.Start <= span.Start && span.End <= right.End) {
                continue
            }
            if best == nil || accessor.Span.Length < best.Span.Length {
                best = accessor
            }
        }
        return best
    }
}

/// GS0154, GS0155, GS0156, GS0274 on a nullable value in a non-nullable position:
/// `expr` → `(expr ?? default)` and `expr` → `(expr!!)` (ADR-0099, moved to Core by ADR-0227 D7).
/// @remarks Both fixes are (cref:Applicability.MaybeIncorrect): the default can be the wrong value,
/// and `!!` throws at run time when the value is nil. The literal `nil` (GS0274) gets no fix.
internal class NullableValueCodeFixProvider : GSharpCodeFixProvider {
    /// The title of the null-assertion fix.
    const NullAssertionTitle string = "Assert non-nil with '!!'"

    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create(
        "GS0154",
        "GS0155",
        "GS0156",
        "GS0274"
    )

    override prop Id string -> "GSharp.CodeFixes.NullableValue"

    override func RegisterCodeFixes(context CodeFixContext) {
        let diagnostic = context.Diagnostic
        if !TryGetNullableConversionTypes(diagnostic, out var sourceType, out var targetType) {
            return
        }
        let span = diagnostic.Location.Span
        if span.Length == 0 || span.End > context.Tree.Text.Length {
            return
        }
        let node SyntaxNode? = FixSyntax.NodeWithSpan(context.Tree, span)
        if node == nil {
            return
        }
        let original = context.Tree.Text.ToString(span)
        if string.Equals(original.Trim(), "nil", StringComparison.Ordinal) {
            return
        }
        let elvisDefault = SuggestDefaultLiteral(targetType)
        let target = node
        context.RegisterFix(
            "Provide default with '?? ${elvisDefault}'",
            "GS0154.NullCoalescingDefault",
            Applicability.MaybeIncorrect,
            (editor SyntaxEditor) -> editor.ReplaceNode(
                target,
                "(${Operand(editor.OriginalText(target), target)} ?? ${elvisDefault})"
            )
        )
        context.RegisterFix(
            NullAssertionTitle,
            "GS0154.NullAssertion",
            Applicability.MaybeIncorrect,
            (editor SyntaxEditor) -> editor.ReplaceNode(target, "(${Operand(editor.OriginalText(target), target)}!!)")
        )
    }

    // `!!` binds tighter than a binary operator (`a + b!!` asserts only `b`), and `??` binds tighter
    // than an assignment (`x = y ?? 0` defaults `y`), so a compound expression is parenthesized first.
    private func Operand(text string, node SyntaxNode) string -> switch node {
        case n is NameExpressionSyntax: text
        case a is AccessorExpressionSyntax: text
        case c is CallExpressionSyntax: text
        case l is LiteralExpressionSyntax: text
        case p is ParenthesizedExpressionSyntax: text
        default: "(${text})"
    }

    // Reads the nullable source type and the target type from the message arguments, or from the
    // quoted names of the message when the arguments are not recorded.
    private func TryGetNullableConversionTypes(
        diagnostic Diagnostic,
        out sourceType string,
        out targetType string
    ) bool {
        sourceType = string.Empty
        targetType = string.Empty
        let arguments = if diagnostic.MessageArguments.IsEmpty {
            QuotedNames(diagnostic.Message)
        } else {
            diagnostic.MessageArguments.ToList()
        }
        switch diagnostic.Id {
            case "GS0155", "GS0156" {
                if arguments.Count < 2 {
                    return false
                }
                sourceType = arguments[0]
                targetType = arguments[1]
            }
            case "GS0154" {
                if arguments.Count < 3 {
                    return false
                }
                targetType = arguments[1]
                sourceType = arguments[2]
            }
            case "GS0274" {
                // The value is the literal `nil`: no fix.
                return false
            }
            default {
                return false
            }
        }
        if string.IsNullOrEmpty(sourceType) || string.IsNullOrEmpty(targetType) || !sourceType.EndsWith(
            "?",
            StringComparison.Ordinal
        ) {
            return false
        }
        return string.Equals(sourceType.Substring(0, sourceType.Length - 1), targetType, StringComparison.Ordinal)
    }

    private func QuotedNames(message string) List[string] {
        let quoted = List[string]()
        var i = 0
        while i < message.Length {
            if message[i] == '\'' {
                let end = message.IndexOf('\'', i + 1)
                if end < 0 {
                    break
                }
                quoted.Add(message.Substring(i + 1, end - i - 1))
                i = end + 1
            } else {
                i++
            }
        }
        return quoted
    }

    // A literal that parses and type-checks for the common built-in types. The user is expected to
    // replace it with a real default.
    private func SuggestDefaultLiteral(targetType string) string -> switch targetType {
        case "string": "\"\""
        case "bool": "false"
        // An `int32` literal widens to `int64` and `float64`; a narrower or unsigned type needs a
        // typed zero, or the fix reports GS0156 again.
        case "int" or "int32" or "int64" or "float" or "float64" or "double": "0"
        case "int8" or
            "int16" or
            "uint8" or
            "uint16" or
            "uint32" or
            "uint64" or
            "float32" or
            "decimal": "${targetType}(0)"
        default: "default"
    }
}

/// Syntax-only nullability checks of the nullability providers (ADR-0099).
internal shared class NullabilitySyntax {
    /// Returns a value that tells whether the receiver looks nullable from the syntax: a `?.`
    /// chain, a `nil` literal, or a name whose declared type clause ends with `?`.
    func ReceiverLooksNullable(tree SyntaxTree, receiver ExpressionSyntax) bool {
        switch receiver {
            case nested is AccessorExpressionSyntax when nested.IsNullConditional {
                return true
            }
            case literal is LiteralExpressionSyntax when literal.LiteralToken.Kind == SyntaxKind.NilKeyword {
                return true
            }
            case name is NameExpressionSyntax {
                return NameDeclaresNullableType(tree, name.IdentifierToken.Text)
            }
            default {
                return false
            }
        }
    }

    private func NameDeclaresNullableType(tree SyntaxTree, name string) bool {
        if string.IsNullOrEmpty(name) {
            return false
        }
        for node in tree.Root.DescendantNodesAndSelf() {
            switch node {
                case v is VariableDeclarationSyntax when v.Identifier?.Text == name &&
                    EndsWithQuestion(tree, v.TypeClause) {
                    return true
                }
                case p is ParameterSyntax when p.Identifier?.Text == name && EndsWithQuestion(tree, p.Type) {
                    return true
                }
                case f is FieldDeclarationSyntax when f.Identifier?.Text == name && EndsWithQuestion(tree, f.Type) {
                    return true
                }
            }
        }
        return false
    }

    private func EndsWithQuestion(tree SyntaxTree, type TypeClauseSyntax?) bool {
        if type == nil {
            return false
        }
        let span = type.Span
        if span.End <= span.Start || span.End > tree.Text.Length {
            return false
        }
        return tree.Text[span.End - 1] == '?'
    }
}
