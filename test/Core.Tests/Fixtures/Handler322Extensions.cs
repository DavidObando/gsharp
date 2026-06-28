// <copyright file="Handler322Extensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

namespace GSharp.Core.Tests.Fixtures;

/// <summary>
/// Issue #322 fixture: an <c>[Extension]</c> method whose non-receiver parameter
/// is <see cref="System.Delegate"/>, mirroring the ASP.NET Core minimal-API
/// <c>MapGet(this ..., string, System.Delegate)</c> shape. When this assembly is
/// supplied as a reference, the binder loads the type through a
/// <see cref="System.Reflection.MetadataLoadContext"/>, so the parameter's
/// <see cref="System.Delegate"/> type lives in a different reflection context
/// than the live runtime <c>Func&lt;&gt;</c> that a lambda literal carries.
/// Resolving a lambda-literal argument against this overload therefore requires
/// classifying the delegate→<see cref="System.Delegate"/> conversion by name
/// across reflection contexts.
/// </summary>
public static class Handler322Extensions
{
    public static string Handle(this string source, System.Delegate handler)
        => source + (handler.DynamicInvoke() as string);
}
