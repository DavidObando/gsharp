// <copyright file="Issue4688EmittedFixtureLifetimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests;

/// <summary>
/// Issue #4688: an emitted fixture's collectible load context must stay alive
/// for as long as the process runs, as <see cref="EmittedFixture"/> documents.
/// </summary>
public class Issue4688EmittedFixtureLifetimeTests
{
    /// <summary>
    /// A loaded fixture assembly is still usable after the garbage collector has
    /// run and finalizers have completed (an unrooted context is unloaded by its
    /// finalizer, and the next type lookup then throws "AssemblyLoadContext is
    /// unloading or was already unloaded").
    /// </summary>
    [Fact]
    public void LoadedFixture_SurvivesGarbageCollection()
    {
        WeakReference assembly = LoadFixtureAssembly();

        for (int i = 0; i < 3; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }

        // The assembly object is held weakly above; re-load strongly to probe the same context.
        Assert.True(assembly.IsAlive, "The fixture assembly (and its context) was collected.");
        var loaded = (Assembly)assembly.Target!; // IsAlive was just asserted.
        Assert.NotEmpty(loaded.GetTypes());
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference LoadFixtureAssembly()
    {
        // Any managed assembly image will do; the test assembly itself is always available.
        byte[] image = File.ReadAllBytes(typeof(Issue4688EmittedFixtureLifetimeTests).Assembly.Location);
        return new WeakReference(EmittedFixture.Load(image));
    }
}
