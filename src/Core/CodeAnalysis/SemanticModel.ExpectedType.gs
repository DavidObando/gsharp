// <copyright file="SemanticModel.ExpectedType.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
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
    /// called function otherwise. A named argument, a variadic slot and a `return` in a lambda answer
    /// nothing.
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
            if current is VariableDeclarationSyntax{TypeClause: not nil, EqualsToken: {} equals} declaration &&
                position >= equals
                .Span
                .End {
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
                position >= call
                .OpenParenthesisToken
                .Span
                .End &&
                (call.CloseParenthesisToken.IsMissing || position <= call.CloseParenthesisToken.Span.Start) {
                return Usable(ArgumentType(call, position, cancellationToken))
            }
            // A function literal or lambda starts another context.
            if current is FunctionLiteralExpressionSyntax || current is LambdaExpressionSyntax {
                return nil
            }
        }
        return nil
    }

    // The return type of the function that a `return` at path[index] leaves. A function literal gives its
    // own; a lambda gives none.
    private func ReturnType(
        path List[SyntaxNode],
        index int32,
        position int32,
        cancellationToken CancellationToken
    ) TypeSymbol? {
        for var i = index - 1; i >= 0; i-- {
            if path[i] is LambdaExpressionSyntax {
                return nil
            }
            if path[i] is FunctionLiteralExpressionSyntax literal {
                // The model does not index a function literal. A literal that initializes a local gets
                // its function from the bound declaration, as (cref:Compilation.Compilation.BindPrefix) does.
                var bound = GetBoundNode(literal, cancellationToken)
                if bound == nil &&
                    i >= 1 &&
                    path[i - 1] is VariableDeclarationSyntax declaration &&
                    GetBoundNode(declaration, cancellationToken) is BoundVariableDeclaration boundDeclaration {
                    bound = boundDeclaration.Initializer
                }
                return if bound is BoundFunctionLiteralExpression boundLiteral {
                    boundLiteral.Function.Type
                } else if bound is BoundExpression{Type: FunctionTypeSymbol functionType} {
                    functionType.ReturnType
                } else {
                    default(TypeSymbol?)
                }
            }
        }
        return if GetEnclosingSymbol(position, cancellationToken) is FunctionSymbol function {
            function.Type
        } else {
            default(TypeSymbol?)
        }
    }

    // The parameter type that every candidate of [`call`](paramref) has at the slot of [`position`](paramref).
    private func ArgumentType(
        call CallExpressionSyntax,
        position int32,
        cancellationToken CancellationToken
    ) TypeSymbol? {
        var slot = 0
        for item in call.Arguments.GetWithSeparators() {
            if item is SyntaxToken{Kind: SyntaxKind.CommaToken, IsMissing: false} separator &&
                separator
                .Span
                .End <= position {
                slot++
            }
        }
        if slot < call.Arguments.Count && call.Arguments[slot] is NamedArgumentExpressionSyntax {
            return nil
        }
        var candidates = GetMemberGroup(call, cancellationToken)
        if candidates.IsDefaultOrEmpty && GetSymbolInfo(call, cancellationToken).Symbol is {} called {
            candidates = ImmutableArray.Create(called)
        }
        var expected TypeSymbol? = nil
        for candidate in candidates {
            if candidate is not FunctionSymbol function {
                return nil
            }
            let parameters = function.Parameters
            if slot >= parameters.Length || parameters[slot].IsVariadic {
                return nil
            }
            let type = parameters[slot].Type
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
