// <copyright file="BodyFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering
import System.Runtime.CompilerServices

/// Issue #5131: facts about one bound body, computed once per body object.
/// Each fact is a pure function of the immutable bound tree, so every
/// consumer of the same body object reads one answer instead of walking the
/// tree again. A body is keyed by reference; a rewritten body is a new object
/// and is computed on its own.
///
/// An entry lives as long as its body. A slot is filled under the entry's
/// lock, so concurrent callers compute a fact once, and a walk that throws
/// leaves the slot empty. The measurement counters `bodyfacts.*-walks` and
/// `bodyfacts.*-reuses` report which happened.
internal shared class BodyFacts {
    private class YieldDetector : BoundTreeWalker {
        prop Found bool {
            get;
            private set;
        }

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            Found = true
        }
    }

    private class Slots {
        internal var ContainsYield bool?
        internal var LoweredLambdaBody BoundBlockStatement?
    }

    private let Entries ConditionalWeakTable[BoundStatement, Slots] = ConditionalWeakTable[BoundStatement, Slots]()
    private let CreateSlots ConditionalWeakTable[BoundStatement, Slots].CreateValueCallback = (_ BoundStatement) ->
    Slots()

    /// Returns whether [`body`](paramref) contains a yield in its own lexical
    /// scope. Nested function and lambda bodies are opaque.
    /// @param body The bound body.
    /// @returns `true` when the body's own lexical scope contains a yield.
    func ContainsYield(body BoundStatement) bool {
        let slots = Entries.GetValue(body, CreateSlots)
        lock slots {
            if slots.ContainsYield is {} cached {
                CompilationMeasurements.Count("bodyfacts.yield-reuses")
                return cached
            }
            let detector = YieldDetector()
            detector.Visit(body)
            CompilationMeasurements.Count("bodyfacts.yield-walks")
            slots.ContainsYield = detector.Found
            return detector.Found
        }
    }

    /// Returns the lowered form of a function-literal body for the flow
    /// analyses that run before emit. Lowering reads only the tree, so the
    /// definite-assignment and ref-struct liveness analyses of one body share a
    /// single lowering of each literal. The result is for analysis only: the
    /// emitter lowers the body it emits on its own.
    /// @param body The function literal's bound body.
    /// @returns The lowered body.
    func LowerLambdaBody(body BoundStatement) BoundBlockStatement {
        let slots = Entries.GetValue(body, CreateSlots)
        lock slots {
            if slots.LoweredLambdaBody != nil {
                CompilationMeasurements.Count("bodyfacts.lambda-lowering-reuses")
                return slots.LoweredLambdaBody!!
            }
            let lowered = Lowerer.Lower(body)
            CompilationMeasurements.Count("bodyfacts.lambda-lowerings")
            slots.LoweredLambdaBody = lowered
            return lowered
        }
    }
}
