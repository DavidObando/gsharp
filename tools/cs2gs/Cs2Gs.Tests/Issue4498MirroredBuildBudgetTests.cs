// <copyright file="Issue4498MirroredBuildBudgetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4498: the mirrored <c>dotnet build</c> has its own budget. It used to
/// share the ten-minute test-run floor, and a hot-core test app's build (the app
/// plus its whole project-reference closure) runs close to that on a nightly
/// runner.
/// </summary>
public class Issue4498MirroredBuildBudgetTests
{
    [Fact]
    public void MirroredBuildBudget_ExceedsTheTestRunFloor_AndStaysUnderTheCeiling()
    {
        Assert.True(SdkCompileRunner.MirroredBuildTimeout > SdkCompileRunner.MirroredTestRunTimeout);
        Assert.True(SdkCompileRunner.MirroredBuildTimeout <= SdkCompileRunner.MirroredTestRunTimeoutCeiling);
        Assert.Equal(TimeSpan.FromMinutes(20), SdkCompileRunner.MirroredBuildTimeout);
    }
}
