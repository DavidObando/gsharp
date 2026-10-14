// <copyright file="TestHostProcessSetup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Reflection
import System.Runtime.CompilerServices
import Xunit

internal shared class TestHostProcessSetup {
    @ModuleInitializer
    internal func Initialize() {
        // Nested SDK builds otherwise retain MSBuild workers until the test host
        // exhausts its resources and crashes non-deterministically (#2407).
        Environment.SetEnvironmentVariable("MSBUILDDISABLENODEREUSE", "1")
    }
}

open class TestHostProcessSetupTests {
    @Fact
    func NestedBuildsDisableMsBuildNodeReuse() {
        Assert.Equal("1", Environment.GetEnvironmentVariable("MSBUILDDISABLENODEREUSE"))
    }

    @Fact
    func NestedBuildsAreSerialized() {
        let behavior CollectionBehaviorAttribute? = typeof(TestHostProcessSetupTests)
            .Assembly
            .GetCustomAttribute[CollectionBehaviorAttribute]()
        Assert.NotNull(behavior)
        Assert.True(behavior!!.DisableTestParallelization)
    }
}
