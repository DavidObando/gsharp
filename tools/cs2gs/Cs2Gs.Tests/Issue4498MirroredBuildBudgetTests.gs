// <copyright file="Issue4498MirroredBuildBudgetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import Xunit

/// Issue #4498: the mirrored `dotnet build` has its own budget. It used to
/// share the ten-minute test-run floor, and a hot-core test app's build (the app
/// plus its whole project-reference closure) runs close to that on a nightly
/// runner.
open class Issue4498MirroredBuildBudgetTests {
    @Fact
    func MirroredBuildBudget_ExceedsTheTestRunFloor_AndStaysUnderTheCeiling() {
        Assert.True(SdkCompileRunner.MirroredBuildTimeout > SdkCompileRunner.MirroredTestRunTimeout)
        Assert.True(SdkCompileRunner.MirroredBuildTimeout <= SdkCompileRunner.MirroredTestRunTimeoutCeiling)
        Assert.Equal(TimeSpan.FromMinutes(20), SdkCompileRunner.MirroredBuildTimeout)
    }
}
