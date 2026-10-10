// <copyright file="Issue4853StopAfterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using System.Reflection;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #4853: <c>cs2gs migrate --stop-after</c> selects a stage prefix.</summary>
public sealed class Issue4853StopAfterTests
{
    [Theory]
    [InlineData("translate", new[] { "translate" })]
    [InlineData("compile", new[] { "translate", "compile" })]
    [InlineData("ilverify", new[] { "translate", "compile", "ilverify" })]
    [InlineData("test-parity", new[] { "translate", "compile", "ilverify", "test-parity" })]
    public void StopAfter_ParsesToTheStagePrefix(string name, string[] expected)
    {
        object parsed = Parse("--corpus", "/nonexistent-corpus", "--stop-after", name);

        Assert.NotNull(parsed);
        var stopAfter = (MigrationStageKind?)parsed.GetType().GetProperty("StopAfter").GetValue(parsed);
        Assert.Equal(
            expected,
            MigrationPipeline.StagesThrough(stopAfter.Value)
                .Select(stage => TriageSerialization.StageName(stage.Kind))
                .ToArray());
    }

    [Fact]
    public void StopAfter_DefaultsToAllStages()
    {
        object parsed = Parse("--corpus", "/nonexistent-corpus");

        Assert.NotNull(parsed);
        Assert.Null((MigrationStageKind?)parsed.GetType().GetProperty("StopAfter").GetValue(parsed));
    }

    [Fact]
    public void StopAfter_RejectsAnUnknownStage()
    {
        Assert.Null(Parse("--corpus", "/nonexistent-corpus", "--stop-after", "polish"));
    }

    private static object Parse(params string[] args)
    {
        MethodInfo parse = typeof(Cs2Gs.Cli.Program).GetMethod(
            "ParseMigrateArgs",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(parse);
        return parse.Invoke(null, new object[] { args, false });
    }
}
