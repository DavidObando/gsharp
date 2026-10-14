// <copyright file="RuntimeAssemblyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System.Reflection
import Xunit

/// ADR-0174 P1-1: the runtime assembly exists under its ADR-mandated identity.
open class RuntimeAssemblyTests {
    @Fact
    func Assembly_IsNamedGsharpRuntimeChannels_InGsharpConcurrencyNamespace() {
        let assembly = typeof(Chan).Assembly
        Assert.Equal("Gsharp.Runtime.Channels", assembly.GetName().Name)
        Assert.Equal("Gsharp.Concurrency", typeof(Chan).Namespace)
    }
}
