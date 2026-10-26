// <copyright file="BoundFunctionLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable

/// A bound function literal (Phase 4.7). Holds a synthesized
/// (cref:FunctionSymbol) together with the bound body. The set of
/// captured outer variables is recorded so the evaluator can snapshot them
/// when the literal is evaluated to a runtime closure value.
class BoundFunctionLiteralExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        function FunctionSymbol,
        type FunctionTypeSymbol,
        body BoundBlockStatement,
        capturedVariables ImmutableArray[VariableSymbol]
    ) : base(syntax) {
        Function = function
        function.IsFunctionLiteral = true
        FunctionType = type
        Body = body
        CapturedVariables = capturedVariables
    }

    prop Function FunctionSymbol {
        get;
    }

    prop FunctionType FunctionTypeSymbol {
        get;
    }

    prop Body BoundBlockStatement {
        get;
    }

    /// Gets the set of outer variables this literal reads or writes. The
    /// setter is internal: issue #4221's transitive-capture reconciliation
    /// ((cref:LambdaBinder.ReconcileGenericLocalFunctionGroupCaptures))
    /// widens this set after initial binding when a generic local function
    /// calls a sibling that itself captures outer state, so the caller's
    /// synthesized environment ends up with a field for every variable any
    /// callee it directly invokes will need at the call site.
    prop CapturedVariables ImmutableArray[VariableSymbol] {
        get;
        internal set;
    }

    override prop Type TypeSymbol -> FunctionType
    override prop Kind BoundNodeKind -> BoundNodeKind.FunctionLiteralExpression

    /// Gets or sets the analysis body produced by (cref:BodyFacts.LowerLambdaBody).
    /// Rewritten literals have a new body and start with an empty slot.
    internal prop LoweredBody BoundBlockStatement?

    /// Gets or sets the enclosing method/type type parameter this GENERIC
    /// local-function literal (`let Name[T, ...] = func ...`)
    /// referenced in its own signature, an own type-parameter constraint, or
    /// its body, cached at the literal's own bind time (see
    /// (cref:LambdaBinder.PrepareGenericLocalFunctionDeclaration)).
    /// Null for every literal outside that gate's scope. Issue #4223/#4221
    /// merge follow-up: the gate rejects this combination only when the
    /// literal ALSO captures outer state (issue #4221/#4252's capturing
    /// generic-local-function path has not been extended to carry an extra
    /// enclosing type parameter the way the zero-capture path has); but
    /// (cref:CapturedVariables) can be widened AFTER that initial
    /// check, by (cref:LambdaBinder.ReconcileGenericLocalFunctionGroupCaptures),
    /// for a forward reference to, or a call cycle with, a sibling that
    /// captures outer state. Caching the offender here lets that later
    /// widening re-evaluate the exclusion instead of silently letting an
    /// unsupported shape reach the emitter.
    internal prop EnclosingTypeParameterOffender TypeParameterSymbol?

    /// Gets or sets the site to report (cref:EnclosingTypeParameterOffender)
    /// against, valid whenever that property is non-null.
    internal prop EnclosingTypeParameterOffenderLocation TextLocation

    /// Gets or sets a value indicating whether the "local function cannot
    /// reference enclosing type parameter" diagnostic has already been
    /// reported for this literal, so a later re-check (after
    /// (cref:CapturedVariables) widens) does not report it a second
    /// time.
    internal prop EnclosingTypeParameterDiagnosticReported bool
}
