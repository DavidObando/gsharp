// <copyright file="Adr0156DefaultEngineFlipTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using ReplProgram = GSharp.Repl.Program;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 Phase 3a: interactive <c>gsi</c> defaults to the emitted
/// submission-chaining engine. Only an explicit <c>--engine evaluator</c> (or
/// <c>GSI_ENGINE=evaluator</c>) selects the legacy tree-walking engine — a
/// deprecated escape hatch that retires with the evaluator in Phase 3c.
/// Witness (ADR-0154): <see cref="ReplProgram.UsesEvaluatorEngine"/> is the
/// single interactive engine-selection predicate and does not exist before
/// the flip; before this change the equivalent condition defaulted the
/// unset/null choice to the evaluator, so
/// <see cref="DefaultEngineChoiceSelectsEmittedEngine"/> pins the flipped
/// behavior itself.
/// </summary>
public sealed class Adr0156DefaultEngineFlipTests
{
    [Fact]
    public void DefaultEngineChoiceSelectsEmittedEngine()
    {
        // No --engine and no GSI_ENGINE: the emitted engine is the default.
        Assert.False(ReplProgram.UsesEvaluatorEngine(null));
    }

    [Fact]
    public void ExplicitEmitChoiceSelectsEmittedEngine()
    {
        Assert.False(ReplProgram.UsesEvaluatorEngine("emit"));
    }

    [Fact]
    public void ExplicitEvaluatorChoiceSelectsEvaluatorEscapeHatch()
    {
        Assert.True(ReplProgram.UsesEvaluatorEngine("evaluator"));
    }

    [Fact]
    public void EnvironmentVariableStillSelectsEvaluatorEscapeHatch()
    {
        var previous = Environment.GetEnvironmentVariable("GSI_ENGINE");
        try
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", "EVALUATOR");
            var choice = ReplProgram.EngineChoiceFromEnvironment();
            Assert.Equal("evaluator", choice);
            Assert.True(ReplProgram.UsesEvaluatorEngine(choice));
        }
        finally
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", previous);
        }
    }

    [Fact]
    public void UnsetEnvironmentVariableYieldsDefaultEmittedEngine()
    {
        var previous = Environment.GetEnvironmentVariable("GSI_ENGINE");
        try
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", null);
            var choice = ReplProgram.EngineChoiceFromEnvironment();
            Assert.Null(choice);
            Assert.False(ReplProgram.UsesEvaluatorEngine(choice));
        }
        finally
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", previous);
        }
    }
}
