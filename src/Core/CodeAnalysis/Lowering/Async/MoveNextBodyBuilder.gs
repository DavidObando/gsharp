// <copyright file="MoveNextBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Plans the canonical `MoveNext` body shape for an async state machine.
/// @remarks This is the first behavior-safe slice of `MoveNext` construction: it
/// defines the labels and await-resume dispatch map that later lowering will
/// consume when replacing each (cref:BoundAwaitExpression) with the
/// Roslyn-compatible suspension sequence. It does not emit a rewritten body yet.
shared class MoveNextBodyBuilder {
    /// Builds the label and resume-state plan for one async state-machine
    /// `MoveNext` body.
    /// @param loweredBody The lowered async method body.
    /// @param awaitResumeStates Await expressions and their allocated state numbers.
    /// @returns The planned `MoveNext` body shape.
    func Build(
        loweredBody BoundBlockStatement?,
        awaitResumeStates ImmutableDictionary[BoundAwaitExpression, int32]?
    ) MoveNextBodyPlan {
        var awaitResumeStates = awaitResumeStates
        if loweredBody == nil {
            throw ArgumentNullException("loweredBody")
        }
        awaitResumeStates ??= ImmutableDictionary[BoundAwaitExpression, int32].Empty
        let resumePoints = awaitResumeStates!!
            .OrderBy((pair KeyValuePair[BoundAwaitExpression, int32]) -> pair.Value)
            .Select(
            (pair KeyValuePair[BoundAwaitExpression, int32]) -> AwaitResumePoint(
                pair.Key,
                pair.Value,
                Label("await_resume_" + pair.Value.ToString()),
                Label("await_resume_after_" + pair.Value.ToString())
            )
        )
            .ToImmutableArray()
        return MoveNextBodyPlan(loweredBody, Label("dispatch"), Label("expr_return"), Label("exit"), resumePoints)
    }

    private func Label(name string) BoundLabel {
        return BoundLabel("<>sm_" + name)
    }
}

/// Planned labels and resume points for a synthesized `MoveNext` body.
class MoveNextBodyPlan {
    /// Initializes a new instance of the (cref:MoveNextBodyPlan) class.
    /// @param loweredBody The lowered body that will be rewritten into `MoveNext`.
    /// @param dispatchLabel The label used by the initial state dispatch.
    /// @param expressionReturnLabel The label used by async-return funneling.
    /// @param exitLabel The label used when leaving `MoveNext`, including suspension exits.
    /// @param awaitResumePoints The await resume-point map.
    init(
        loweredBody BoundBlockStatement,
        dispatchLabel BoundLabel,
        expressionReturnLabel BoundLabel,
        exitLabel BoundLabel,
        awaitResumePoints ImmutableArray[AwaitResumePoint]
    ) {
        LoweredBody = loweredBody ?? throw ArgumentNullException("loweredBody")
        DispatchLabel = dispatchLabel ?? throw ArgumentNullException("dispatchLabel")
        ExpressionReturnLabel = expressionReturnLabel ?? throw ArgumentNullException("expressionReturnLabel")
        ExitLabel = exitLabel ?? throw ArgumentNullException("exitLabel")
        AwaitResumePoints = if awaitResumePoints.IsDefault {
            ImmutableArray[AwaitResumePoint].Empty
        } else {
            awaitResumePoints
        }
    }

    /// Gets the lowered body that will be rewritten into `MoveNext`.
    prop LoweredBody BoundBlockStatement {
        get;
    }

    /// Gets the label used by the initial state dispatch.
    prop DispatchLabel BoundLabel {
        get;
    }

    /// Gets the label used by async-return funneling.
    prop ExpressionReturnLabel BoundLabel {
        get;
    }

    /// Gets the label used when leaving `MoveNext`.
    prop ExitLabel BoundLabel {
        get;
    }

    /// Gets await resume points ordered by state number.
    prop AwaitResumePoints ImmutableArray[AwaitResumePoint] {
        get;
    }
}

/// Planned labels for one suspending await in `MoveNext`.
class AwaitResumePoint {
    /// Initializes a new instance of the (cref:AwaitResumePoint) class.
    /// @param awaitExpression The await expression in the lowered body.
    /// @param state The state assigned to this suspension point.
    /// @param resumeLabel The state-dispatch target used on re-entry.
    /// @param resumeAfterLabel The label shared by synchronous and resumed completion paths.
    init(awaitExpression BoundAwaitExpression, state int32, resumeLabel BoundLabel, resumeAfterLabel BoundLabel) {
        AwaitExpression = awaitExpression ?? throw ArgumentNullException("awaitExpression")
        State = state
        ResumeLabel = resumeLabel ?? throw ArgumentNullException("resumeLabel")
        ResumeAfterLabel = resumeAfterLabel ?? throw ArgumentNullException("resumeAfterLabel")
    }

    /// Gets the await expression in the lowered body.
    prop AwaitExpression BoundAwaitExpression {
        get;
    }

    /// Gets the state assigned to this suspension point.
    prop State int32 {
        get;
    }

    /// Gets the state-dispatch target used on re-entry.
    prop ResumeLabel BoundLabel {
        get;
    }

    /// Gets the label shared by synchronous and resumed completion paths.
    prop ResumeAfterLabel BoundLabel {
        get;
    }
}
