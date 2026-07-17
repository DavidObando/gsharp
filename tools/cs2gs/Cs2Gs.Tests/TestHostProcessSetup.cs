// <copyright file="TestHostProcessSetup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.CompilerServices;
using Xunit;

namespace Cs2Gs.Tests;

internal static class TestHostProcessSetup
{
    [ModuleInitializer]
    internal static void Initialize()
    {
        // Nested SDK builds otherwise retain MSBuild workers until the test host
        // exhausts its resources and crashes non-deterministically (#2407).
        Environment.SetEnvironmentVariable("MSBUILDDISABLENODEREUSE", "1");
    }
}

public class TestHostProcessSetupTests
{
    [Fact]
    public void NestedBuildsDisableMsBuildNodeReuse()
    {
        Assert.Equal("1", Environment.GetEnvironmentVariable("MSBUILDDISABLENODEREUSE"));
    }
}
