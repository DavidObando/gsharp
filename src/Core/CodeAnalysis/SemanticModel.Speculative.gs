// <copyright file="SemanticModel.Speculative.cs" company="GSharp">
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
import System.Linq
import System.Threading

/// Speculative queries of (cref:SemanticModel) (ADR-0212 section 7b).
partial class SemanticModel {
    /// Binds [`expression`](paramref) as if it stood at [`position`](paramref) and
    /// returns its type. The enclosing declared function comes from
    /// (cref:GetEnclosingSymbol), the locals and parameters from
    /// (cref:LookupSymbols) with their declared types, the in-scope local function
    /// overloads from the enclosing blocks, and the file's imports from
    /// the compilation. Binding runs under the compilation's nullability mode.
    /// No diagnostic escapes.
    /// @remarks Flow-sensitive state is excluded from the contract (ADR-0212 Q15):
    /// the speculative binder starts with empty narrowing state, so `p.X` speculated
    /// inside `if p != nil` with `p Point?` sees the declared `Point?`. Use
    /// (cref:GetReceiverTypeInfo) for the flow type of an expression the binder bound.
    /// @param position A character offset into this model's tree.
    /// @param expression The expression to bind; this model's tree supplies the imports, also for an expression parsed on its own.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The type; (cref:TypeInfo.Type) is null when the bind fails or the type is an error or `void`.
    func GetSpeculativeTypeInfo(
        position int32,
        expression ExpressionSyntax,
        cancellationToken CancellationToken = default(CancellationToken)
    ) TypeInfo {
        cancellationToken.ThrowIfCancellationRequested()
        ArgumentNullException.ThrowIfNull(expression)
        // The enclosing function, constructors and accessors included, is the context. The locals in scope come
        // from LookupSymbols either way, so the locals of top-level statements are visible too. The globals are
        // reachable through the parent scope.
        var function FunctionSymbol? = nil
        var inConstructorInitializer = false
        let locals = List[VariableSymbol](LookupSymbols(position, nil, cancellationToken).OfType[VariableSymbol]())
        let localFunctionScopes = ScopedLocalFunctionScopes(position)
        let localTypeParameters = EnclosingLocalFunctionTypeParameters(position)
        if GetEnclosingSymbol(position, cancellationToken) is FunctionSymbol enclosing {
            function = enclosing
            // The scope query leaves `this` out where the receiver does not exist yet, as in the
            // arguments of a constructor's `: base(...)`. The binder then applies the restrictions of
            // that context: instance access is rejected, the static members stay reachable.
            inConstructorInitializer = enclosing.ThisParameter != nil && !locals.Contains(enclosing.ThisParameter)
        }
        using let nullabilityScope = NullabilityOptions.Enter(compilation.Nullability, compilation.PlatformNilChecks)
        let type = Binder.BindSpeculativeExpressionType(
            compilation.GlobalScope,
            compilation.References ?? ReferenceResolver.Default(),
            function,
            locals,
            localFunctionScopes,
            expression,
            syntaxTree,
            inConstructorInitializer,
            localTypeParameters
        )
        return TypeInfo(type)
    }

    /// Binds [`statement`](paramref) as if its text stood at [`position`](paramref) of this model's text,
    /// and returns its classified diagnostics and the locals that it declares (ADR-0229, #6176). The
    /// bind is the bind of the text with the statement inserted: for a prefix tree (the tree of a
    /// (cref:PrefixBindResult)), (cref:Compilation.Compilation.BindPrefix) with the same remainder and
    /// the cut moved past the statement; for a complete tree, the complete text, and every diagnostic is
    /// final. It runs every analysis that such a bind runs, flow analysis included, so it costs a bind of
    /// the text. Nothing changes in this model's compilation.
    /// @param position A character offset into this model's text, at a statement boundary. In a prefix tree
    /// it is at or before the cut.
    /// @param statement The statement to insert, for example from (cref:Syntax.SyntaxTree.ParseStatement).
    /// @param cancellationToken Cancels this caller's wait for the bind.
    /// @returns The diagnostics located in the inserted statement and the locals that it declares.
    func GetSpeculativeStatementDiagnostics(
        position int32,
        statement StatementSyntax,
        cancellationToken CancellationToken = default(CancellationToken)
    ) SpeculativeStatementResult {
        cancellationToken.ThrowIfCancellationRequested()
        ArgumentNullException.ThrowIfNull(statement, paramName: "statement")
        let text = syntaxTree.Text
        let prefix = syntaxTree.Prefix
        let limit = if prefix != nil {
            prefix.Cut
        } else {
            text.Length
        }
        if position < 0 || position > limit {
            throw ArgumentOutOfRangeException(
                "position",
                position,
                "The position must be in the text, at or before the cut."
            )
        }
        // The statement gets lines of its own, so that it neither continues the text before it nor runs into
        // the text after it.
        let statementText = statement.SyntaxTree.Text.ToString(statement.Span)
        let inserted = "\n" + statementText + "\n"
        let host = text.ToString()
        let insertedText = SourceText.From(
            host.Substring(0, position) + inserted + host.Substring(position),
            text.FileName
        )
        let insertedTree = SyntaxTree.Parse(insertedText)
        let statementSpan = TextSpan(position + 1, statementText.Length)
        let snapshot = compilation.WithReplacedSyntaxTree(syntaxTree, insertedTree)
        var diagnostics = ImmutableArray.CreateBuilder[ClassifiedDiagnostic]()
        var visible ImmutableArray[Symbol]
        var boundTree SyntaxTree
        if prefix != nil {
            let result = snapshot.BindPrefix(
                insertedTree,
                prefix.Cut + inserted.Length,
                PrefixBindOptions(prefix.Remainder, includeScope: true),
                cancellationToken
            )
            for d in result.Diagnostics {
                if InStatement(d.Diagnostic, result.SyntaxTree.Text, statementSpan) {
                    diagnostics.Add(d)
                }
            }
            visible = result.Scope
            boundTree = result.SyntaxTree
        } else {
            for d in snapshot.GetDiagnostics(cancellationToken) {
                if InStatement(d, insertedText, statementSpan) {
                    diagnostics.Add(ClassifiedDiagnostic(d, DiagnosticFinality.Final, string.Empty))
                }
            }
            visible = snapshot.GetSemanticModel(insertedTree).LookupSymbols(
                statementSpan.End + 1,
                cancellationToken: cancellationToken
            )
            boundTree = insertedTree
        }
        // A symbol that the statement declares has its declaration in the statement.
        let declared = ImmutableArray.CreateBuilder[Symbol]()
        for symbol in visible {
            for node in symbol.DeclaringSyntaxNodes {
                if object.ReferenceEquals(node.SyntaxTree.Text, boundTree.Text) &&
                    statementSpan.Start <= node.Span.Start &&
                    node.Span.End <= statementSpan.End {
                    declared.Add(symbol)
                    break
                }
            }
        }
        return SpeculativeStatementResult(diagnostics.ToImmutable(), declared.ToImmutable(), boundTree, statementSpan)
    }

    private func InStatement(
        diagnostic Diagnostic,
        text SourceText,
        statementSpan TextSpan
    ) bool -> object.ReferenceEquals(diagnostic.Location.Text, text) &&
        statementSpan.Start <= diagnostic.Location.Span.Start &&
        diagnostic.Location.Span.End <= statementSpan.End
}
