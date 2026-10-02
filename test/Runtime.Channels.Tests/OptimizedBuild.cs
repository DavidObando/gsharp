// <copyright file="OptimizedBuild.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics;
using System.Reflection;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// Tells the allocation tests whether the code they measure was compiled with
/// optimizations. The allocation bounds hold only for optimized code: a Debug
/// build shapes state machines and locals differently.
/// </summary>
/// <remarks>
/// This replaces <c>#if DEBUG</c>. G# has no conditional compilation, and cs2gs
/// rejects <c>#if</c>, so the choice is made at run time from each assembly's
/// <see cref="DebuggableAttribute"/>. csc and gsc both stamp it from the
/// optimize setting. An assembly without the attribute counts as optimized,
/// so the strict bound is the default.
/// </remarks>
internal static class OptimizedBuild
{
    /// <summary>
    /// Whether the Gsharp.Runtime.Channels library and this test assembly were
    /// both compiled with the JIT optimizer enabled.
    /// </summary>
    /// <returns><see langword="true"/> when the strict allocation bounds apply.</returns>
    public static bool IsOptimized() =>
        IsOptimized(typeof(Gsharp.Concurrency.Chan<int>).Assembly)
        && IsOptimized(typeof(OptimizedBuild).Assembly);

    private static bool IsOptimized(Assembly assembly)
    {
        DebuggableAttribute debuggable = assembly.GetCustomAttribute<DebuggableAttribute>();
        return debuggable == null || !debuggable.IsJITOptimizerDisabled;
    }
}
