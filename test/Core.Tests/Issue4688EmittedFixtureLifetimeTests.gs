// <copyright file="Issue4688EmittedFixtureLifetimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Tests
import System
import System.IO
import System.Reflection
import System.Runtime.CompilerServices
import Xunit

/// Issue #4688: an emitted fixture's collectible load context must stay alive
/// for as long as the process runs, as (cref:EmittedFixture) documents.
open class Issue4688EmittedFixtureLifetimeTests {
    /// A loaded fixture assembly is still usable after the garbage collector has
    /// run and finalizers have completed (an unrooted context is unloaded by its
    /// finalizer, and the next type lookup then throws "AssemblyLoadContext is
    /// unloading or was already unloaded").
    @Fact
    func LoadedFixture_SurvivesGarbageCollection() {
        let assembly = LoadFixtureAssembly()
        for var i = 0; i < 3; i++ {
            GC.Collect()
            GC.WaitForPendingFinalizers()
        }
        // The assembly object is held weakly above; re-load strongly to probe the same context.
        Assert.True(assembly.IsAlive, "The fixture assembly (and its context) was collected.")
        let loaded = cast[Assembly](assembly.Target!!) // IsAlive was just asserted.
        Assert.NotEmpty(loaded.GetTypes())
    }

    shared {
        @MethodImpl(MethodImplOptions.NoInlining)
        private func LoadFixtureAssembly() WeakReference {
            // Any managed assembly image will do; the test assembly itself is always available.
            let image = File.ReadAllBytes(typeof(Issue4688EmittedFixtureLifetimeTests).Assembly.Location)
            return WeakReference(EmittedFixture.Load(image))
        }
    }
}
