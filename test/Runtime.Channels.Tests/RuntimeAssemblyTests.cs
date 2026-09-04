// <copyright file="RuntimeAssemblyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 P1-1: the runtime assembly exists under its ADR-mandated identity.
/// </summary>
public class RuntimeAssemblyTests
{
    [Fact]
    public void Assembly_IsNamedGsharpRuntimeChannels_InGsharpConcurrencyNamespace()
    {
        var assembly = typeof(Chan).Assembly;
        Assert.Equal("Gsharp.Runtime.Channels", assembly.GetName().Name);
        Assert.Equal("Gsharp.Concurrency", typeof(Chan).Namespace);
    }
}
