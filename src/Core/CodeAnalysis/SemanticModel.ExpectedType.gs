// <copyright file="SemanticModel.ExpectedType.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Threading

/// The expected-type query of (cref:SemanticModel) (#6079, ADR-0225 D6.7).
partial class SemanticModel {
    /// Returns the type that the context expects at [`position`](paramref): the parameter of an argument
    /// slot, the declared type of a variable initializer, the return type of a `return` statement, or
    /// the type of the variable that an assignment writes.
    /// @remarks The innermost of these contexts answers. An argument slot answers when every candidate of
    /// the call has the same parameter type at the slot. The candidates are the call's member group
    /// when the compilation records it ((cref:Compilation.Compilation.RecordMemberGroups)), and the
    /// called function otherwise. Only source functions answer, a receiver function called as a member
    /// included. An imported or generic callee, a parameter type with a type parameter, a named argument
    /// at or before the slot, a variadic slot and a `return` in a lambda answer nothing.
    /// @param position A character offset into this model's tree.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The expected type, or `null` when the context expects none, the candidates disagree,
    /// or the type is an error or `void`.
    func GetExpectedType(position int32, cancellationToken CancellationToken = default(CancellationToken)) TypeSymbol? {
        cancellationToken.ThrowIfCancellationRequested()
        let path = List[SyntaxNode]()
        var node SyntaxNode = syntaxTree.Root
        while true {
            path.Add(node)
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                let span = child.Span
                if span.Start <= position && position <= span.End && !(child is SyntaxToken) {
                    next = child
                    break
                }
            }
            if next == nil {
                break
            }
            node = next
        }
        for var i = path.Count - 1; i >= 0; i-- {
            let current = path[i]
            if current is ReturnStatementSyntax returnStatement && position >= returnStatement.ReturnKeyword.Span.End {
                return Usable(ReturnType(path, i, position, cancellationToken))
            }
            // An initializer without a declared type expects nothing; the outer context does not reach it.
            if current is VariableDeclarationSyntax{TypeClause: nil, EqualsToken: {} untypedEquals} &&
                position >= untypedEquals.Span.End {
                return nil
            }
            if current is VariableDeclarationSyntax{TypeClause: not nil, EqualsToken: {} equals} declaration &&
                position >= equals.Span.End {
                return if GetDeclaredSymbol(declaration, cancellationToken) is VariableSymbol variable {
                    Usable(variable.Type)
                } else {
                    default(TypeSymbol?)
                }
            }
            if current is AssignmentExpressionSyntax assignment && position >= assignment.EqualsToken.Span.End {
                return if GetSymbolInfo(
                    assignment.IdentifierToken,
                    cancellationToken
                ).Symbol is VariableSymbol variable {
                    Usable(variable.Type)
                } else {
                    default(TypeSymbol?)
                }
            }
            if current is CallExpressionSyntax call &&
                position >= call.OpenParenthesisToken.Span.End &&
                (call.CloseParenthesisToken.IsMissing || position <= call.CloseParenthesisToken.Span.Start) {
                return Usable(ArgumentType(call, position, cancellationToken))
            }
            // A block expression gives its target type to its trailing expression only (the binder's
            // BindBlockExpressionParts).
            if current is BlockExpressionSyntax block &&
                !(block.Expression is {} trailing && Contains(trailing.Span, position)) {
                return nil
            }
            // The body of a function literal or lambda starts another context; its header does not.
            if current is FunctionLiteralExpressionSyntax literal && Contains(literal.Body.Span, position) {
                return nil
            }
            if current is LambdaExpressionSyntax lambda && Contains(lambda.Body.Span, position) {
                return nil
            }
        }
        return nil
    }

    // The return type of the function that a `return` at path[index] leaves: the declared return type of
    // a function literal, or of the enclosing function. A lambda, a literal without a declared return
    // type, and an `async` or suspending function give none, because the type that a `return` expects
    // differs from the declared one or is inferred.
    private func ReturnType(
        path List[SyntaxNode],
        index int32,
        position int32,
        cancellationToken CancellationToken
    ) TypeSymbol? {
        for var i = index - 1; i >= 0; i-- {
            // The nearest declared function or method, a rich object's method included, owns the return.
            if path[i] is FunctionDeclarationSyntax declaration {
                return if GetDeclaredSymbol(declaration, cancellationToken) is FunctionSymbol declared &&
                    !declared.IsAsyncOrSuspending {
                    declared.Type
                } else {
                    default(TypeSymbol?)
                }
            }
            if path[i] is LambdaExpressionSyntax {
                return nil
            }
            if path[i] is FunctionLiteralExpressionSyntax literal {
                if literal.ReturnTypeClause == nil || literal.IsAsync {
                    return nil
                }
                return if GetDeclaredSymbol(literal, cancellationToken) is FunctionSymbol literalFunction &&
                    !literalFunction.IsAsyncOrSuspending {
                    literalFunction.Type
                } else {
                    default(TypeSymbol?)
                }
            }
        }
        return if GetEnclosingSymbol(position, cancellationToken) is FunctionSymbol function &&
            !function.IsAsyncOrSuspending {
            function.Type
        } else {
            default(TypeSymbol?)
        }
    }

    private func Contains(span TextSpan, position int32) bool -> span.Start <= position && position <= span.End

    // The parameter type that every candidate of [`call`](paramref) has at the slot of [`position`](paramref).
    private func ArgumentType(
        call CallExpressionSyntax,
        position int32,
        cancellationToken CancellationToken
    ) TypeSymbol? {
        var slot = 0
        for item in call.Arguments.GetWithSeparators() {
            if item is SyntaxToken{Kind: SyntaxKind.CommaToken, IsMissing: false} separator &&
                separator.Span.End <= position {
                slot++
            }
        }
        // A named argument at or before the slot moves the positional slots.
        for var i = 0; i <= slot && i < call.Arguments.Count; i++ {
            if call.Arguments[i] is NamedArgumentExpressionSyntax {
                return nil
            }
        }
        var candidates = GetMemberGroup(call, cancellationToken)
        if candidates.IsDefaultOrEmpty && GetSymbolInfo(call, cancellationToken).Symbol is {} called {
            candidates = ImmutableArray.Create(called)
        }
        var expected TypeSymbol? = nil
        for candidate in candidates {
            // Only a source function maps argument slots to its parameters one to one. An imported or
            // extension method, or a generic one, answers nothing.
            if candidate is not FunctionSymbol function || function.IsGeneric {
                return nil
            }
            // A receiver function called as a member takes the receiver as its first parameter.
            var parameterIndex = slot
            if function.IsExtension {
                if !(
                    call.Parent is AccessorExpressionSyntax accessor && object.ReferenceEquals(accessor.RightPart, call)
                ) {
                    return nil
                }
                parameterIndex++
            }
            let parameters = function.Parameters
            if parameterIndex >= parameters.Length || parameters[parameterIndex].IsVariadic {
                return nil
            }
            let type = parameters[parameterIndex].Type
            if TypeSymbol.ContainsTypeParameter(type) {
                return nil
            }
            if expected == nil {
                expected = type
            } else if expected != type {
                return nil
            }
        }
        return expected
    }

    private func Usable(type TypeSymbol?) TypeSymbol? -> if type == nil ||
        type == TypeSymbol.Error ||
        type == TypeSymbol.Void {
        nil
    } else {
        type
    }
}
