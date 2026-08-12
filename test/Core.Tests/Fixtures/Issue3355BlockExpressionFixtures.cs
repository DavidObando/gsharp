// <copyright file="Issue3355BlockExpressionFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>
/// CLR base-constructor overload fixture for issue #3355. First argument
/// selects overload before target-dependent block-lambda argument is rebound.
/// </summary>
public abstract class Issue3355OverloadedBaseFixture
{
    protected Issue3355OverloadedBaseFixture(int value, Func<int, int> transform)
    {
        Value = transform(value);
    }

    protected Issue3355OverloadedBaseFixture(string value, Func<string, string> transform)
    {
        Value = transform(value).Length;
    }

    protected Issue3355OverloadedBaseFixture(int value, Func<int, int, int> transform)
    {
        Value = transform(value, 0);
    }

    public int Value { get; }
}

/// <summary>Imported overload fixture for target-dependent block arguments.</summary>
public static class Issue3355OverloadedMethodFixture
{
    public static int Apply(int value, Func<int, int> transform) => transform(value);

    public static int Apply(int value, Func<int, int, int> transform) => transform(value, 0);

    public static int Apply(int value, Func<string, string> transform, int extra)
        => transform(value.ToString()).Length + extra;
}

/// <summary>Imported constructor overload fixture for target-dependent block arguments.</summary>
public sealed class Issue3355OverloadedObjectFixture
{
    public Issue3355OverloadedObjectFixture(int value, Func<int, int> transform)
    {
        Value = transform(value);
    }

    public Issue3355OverloadedObjectFixture(int value, Func<int, int, int> transform)
    {
        Value = transform(value, 0);
    }

    public Issue3355OverloadedObjectFixture(int value, Func<string, string> transform, int extra)
    {
        Value = transform(value.ToString()).Length + extra;
    }

    public int Value { get; }
}
