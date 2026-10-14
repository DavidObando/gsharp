// <copyright file="BoundForRangeStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Iteration strategies the evaluator picks per collection kind.
enum ForRangeKind {
    Indexed,
    Dictionary,
    Enumerable,
    PatternEnumerator
}

/// Bound for-range statement (Phase 4 exit). Forms:
/// `for v := range coll { ... }` (no key) and
/// `for k, v := range coll { ... }`. For arrays/slices the key is
/// the int index; for CLR dictionaries the key is the dictionary key.
class BoundForRangeStatement : BoundLoopStatement {
    private var locals ImmutableArray[VariableSymbol]

    /// Initializes a new instance of the (cref:BoundForRangeStatement) class.
    /// @param syntax The originating syntax.
    /// @param keyVariable The key variable (may be null when no key was declared).
    /// @param valueVariable The value variable.
    /// @param collection The collection expression.
    /// @param kind The iteration strategy.
    /// @param body The loop body.
    /// @param breakLabel The break label.
    /// @param continueLabel The continue label.
    init(
        syntax SyntaxNode?,
        keyVariable VariableSymbol?,
        valueVariable VariableSymbol,
        collection BoundExpression,
        kind ForRangeKind,
        body BoundStatement,
        breakLabel BoundLabel,
        continueLabel BoundLabel
    ) : base(syntax, breakLabel, continueLabel) {
        KeyVariable = keyVariable
        ValueVariable = valueVariable
        Collection = collection
        IterationKind = kind
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ForRangeStatement

    /// Gets the key variable, or `null` when only a value was
    /// declared (`for v in xs`).
    prop KeyVariable VariableSymbol? {
        get;
    }

    /// Gets the value variable.
    prop ValueVariable VariableSymbol {
        get;
    }

    /// Gets the loop's iteration variables — the Roslyn
    /// `IForEachLoopOperation.Locals` analogue (ADR-0169, issue #4436):
    /// (cref:KeyVariable) when the loop declares one, then
    /// (cref:ValueVariable).
    prop Locals ImmutableArray[VariableSymbol] {
        get {
            // Both variables are fixed at construction, so the array is built
            // once. A default ImmutableArray is the "not yet built" marker.
            if locals.IsDefault {
                let built = if KeyVariable is {} key {
                    ImmutableArray.Create(key, ValueVariable)
                } else {
                    ImmutableArray.Create(ValueVariable)
                }
                ImmutableInterlocked.InterlockedInitialize(&locals, built)
            }
            return locals
        }
    }

    /// Gets the collection expression.
    prop Collection BoundExpression {
        get;
    }

    /// Gets the iteration strategy.
    prop IterationKind ForRangeKind {
        get;
    }

    /// Gets the loop body.
    prop Body BoundStatement {
        get;
    }
}
