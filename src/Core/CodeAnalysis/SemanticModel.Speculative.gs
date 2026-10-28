// <copyright file="SemanticModel.Speculative.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq
import System.Threading

/// Speculative queries of (cref:SemanticModel) (ADR-0212 section 7b).
partial class SemanticModel {
    /// Binds [`expression`](paramref) as if it stood at [`position`](paramref) and
    /// returns its type. The enclosing declared function comes from
    /// (cref:GetEnclosingSymbol), the locals and parameters from
    /// (cref:LookupSymbols) with their declared types, and the file's imports from
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
        // Only a declared function (or method) is a context; constructors and accessors have no
        // declaring function syntax. The locals in scope come from LookupSymbols either way, so the
        // locals of top-level statements are visible too. The globals are reachable through the parent scope.
        var function FunctionSymbol? = nil
        let locals = List[VariableSymbol](LookupSymbols(position, nil, cancellationToken).OfType[VariableSymbol]())
        if GetEnclosingSymbol(position, cancellationToken) is FunctionSymbol enclosing {
            function = enclosing
            // The scope query leaves `this` out where the receiver does not exist yet, as in the
            // arguments of a constructor's `: base(...)`. There the binder gets no function, so it
            // seeds neither the receiver nor the instance members, as normal binding does not.
            if enclosing.ThisParameter != nil && !locals.Contains(enclosing.ThisParameter) {
                function = nil
            }
        }
        using let nullabilityScope = NullabilityOptions.Enter(compilation.Nullability, compilation.PlatformNilChecks)
        let type = Binder.BindSpeculativeExpressionType(
            compilation.GlobalScope,
            compilation.References ?? ReferenceResolver.Default(),
            function,
            locals,
            expression,
            syntaxTree
        )
        return TypeInfo(type)
    }
}
