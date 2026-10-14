// <copyright file="OptimizedBuild.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System.Diagnostics
import System.Reflection

/// Tells the allocation tests whether the code they measure was compiled with
/// optimizations. The allocation bounds hold only for optimized code: a Debug
/// build shapes state machines and locals differently.
/// @remarks This replaces `#if DEBUG`. G# has no conditional compilation, and cs2gs
/// rejects `#if`, so the choice is made at run time from each assembly's
/// (cref:DebuggableAttribute). csc and gsc both stamp it from the
/// optimize setting. An assembly without the attribute counts as optimized,
/// so the strict bound is the default.
internal shared class OptimizedBuild {
    /// Whether the Gsharp.Runtime.Channels library and this test assembly were
    /// both compiled with the JIT optimizer enabled.
    /// @returns `true` when the strict allocation bounds apply.
    func IsOptimized() bool -> IsOptimized(typeof(Chan[int32]).Assembly) && IsOptimized(typeof(OptimizedBuild).Assembly)

    private func IsOptimized(assembly Assembly) bool {
        let debuggable DebuggableAttribute? = assembly.GetCustomAttribute[DebuggableAttribute]()
        return debuggable == nil || !debuggable.IsJITOptimizerDisabled
    }
}
