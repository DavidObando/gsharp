#nullable disable

// <copyright file="MoveNextBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Plans the canonical <c>MoveNext</c> body shape for an async state machine.
/// </summary>
/// <remarks>
/// This is the first behavior-safe slice of <c>MoveNext</c> construction: it
/// defines the labels and await-resume dispatch map that later lowering will
/// consume when replacing each <see cref="BoundAwaitExpression"/> with the
/// Roslyn-compatible suspension sequence. It does not emit a rewritten body yet.
/// </remarks>
public static class MoveNextBodyBuilder
{
    /// <summary>
    /// Builds the label and resume-state plan for one async state-machine
    /// <c>MoveNext</c> body.
    /// </summary>
    /// <param name="loweredBody">The lowered async method body.</param>
    /// <param name="awaitResumeStates">Await expressions and their allocated state numbers.</param>
    /// <returns>The planned <c>MoveNext</c> body shape.</returns>
    public static MoveNextBodyPlan Build(
        BoundBlockStatement loweredBody,
        ImmutableDictionary<BoundAwaitExpression, int> awaitResumeStates)
    {
        if (loweredBody == null)
        {
            throw new ArgumentNullException(nameof(loweredBody));
        }

        awaitResumeStates ??= ImmutableDictionary<BoundAwaitExpression, int>.Empty;

        var resumePoints = awaitResumeStates
            .OrderBy(pair => pair.Value)
            .Select(pair => new AwaitResumePoint(
                pair.Key,
                pair.Value,
                Label("await_resume_" + pair.Value),
                Label("await_resume_after_" + pair.Value)))
            .ToImmutableArray();

        return new MoveNextBodyPlan(
            loweredBody,
            Label("dispatch"),
            Label("expr_return"),
            Label("exit"),
            resumePoints);
    }

    private static BoundLabel Label(string name)
    {
        return new BoundLabel("<>sm_" + name);
    }
}

/// <summary>
/// Planned labels and resume points for a synthesized <c>MoveNext</c> body.
/// </summary>
public sealed class MoveNextBodyPlan
{
    /// <summary>Initializes a new instance of the <see cref="MoveNextBodyPlan"/> class.</summary>
    /// <param name="loweredBody">The lowered body that will be rewritten into <c>MoveNext</c>.</param>
    /// <param name="dispatchLabel">The label used by the initial state dispatch.</param>
    /// <param name="expressionReturnLabel">The label used by async-return funneling.</param>
    /// <param name="exitLabel">The label used when leaving <c>MoveNext</c>, including suspension exits.</param>
    /// <param name="awaitResumePoints">The await resume-point map.</param>
    public MoveNextBodyPlan(
        BoundBlockStatement loweredBody,
        BoundLabel dispatchLabel,
        BoundLabel expressionReturnLabel,
        BoundLabel exitLabel,
        ImmutableArray<AwaitResumePoint> awaitResumePoints)
    {
        LoweredBody = loweredBody ?? throw new ArgumentNullException(nameof(loweredBody));
        DispatchLabel = dispatchLabel ?? throw new ArgumentNullException(nameof(dispatchLabel));
        ExpressionReturnLabel = expressionReturnLabel ?? throw new ArgumentNullException(nameof(expressionReturnLabel));
        ExitLabel = exitLabel ?? throw new ArgumentNullException(nameof(exitLabel));
        AwaitResumePoints = awaitResumePoints.IsDefault
            ? ImmutableArray<AwaitResumePoint>.Empty
            : awaitResumePoints;
    }

    /// <summary>Gets the lowered body that will be rewritten into <c>MoveNext</c>.</summary>
    public BoundBlockStatement LoweredBody { get; }

    /// <summary>Gets the label used by the initial state dispatch.</summary>
    public BoundLabel DispatchLabel { get; }

    /// <summary>Gets the label used by async-return funneling.</summary>
    public BoundLabel ExpressionReturnLabel { get; }

    /// <summary>Gets the label used when leaving <c>MoveNext</c>.</summary>
    public BoundLabel ExitLabel { get; }

    /// <summary>Gets await resume points ordered by state number.</summary>
    public ImmutableArray<AwaitResumePoint> AwaitResumePoints { get; }
}

/// <summary>
/// Planned labels for one suspending await in <c>MoveNext</c>.
/// </summary>
public sealed class AwaitResumePoint
{
    /// <summary>Initializes a new instance of the <see cref="AwaitResumePoint"/> class.</summary>
    /// <param name="awaitExpression">The await expression in the lowered body.</param>
    /// <param name="state">The state assigned to this suspension point.</param>
    /// <param name="resumeLabel">The state-dispatch target used on re-entry.</param>
    /// <param name="resumeAfterLabel">The label shared by synchronous and resumed completion paths.</param>
    public AwaitResumePoint(
        BoundAwaitExpression awaitExpression,
        int state,
        BoundLabel resumeLabel,
        BoundLabel resumeAfterLabel)
    {
        AwaitExpression = awaitExpression ?? throw new ArgumentNullException(nameof(awaitExpression));
        State = state;
        ResumeLabel = resumeLabel ?? throw new ArgumentNullException(nameof(resumeLabel));
        ResumeAfterLabel = resumeAfterLabel ?? throw new ArgumentNullException(nameof(resumeAfterLabel));
    }

    /// <summary>Gets the await expression in the lowered body.</summary>
    public BoundAwaitExpression AwaitExpression { get; }

    /// <summary>Gets the state assigned to this suspension point.</summary>
    public int State { get; }

    /// <summary>Gets the state-dispatch target used on re-entry.</summary>
    public BoundLabel ResumeLabel { get; }

    /// <summary>Gets the label shared by synchronous and resumed completion paths.</summary>
    public BoundLabel ResumeAfterLabel { get; }
}
