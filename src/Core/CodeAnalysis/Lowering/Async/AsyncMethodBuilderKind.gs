// <copyright file="AsyncMethodBuilderKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

/// Categorises the BCL async method builder selected for an `async`
/// method (see `~/roslyn-async.md` §1).
enum AsyncMethodBuilderKind {
    Unknown,
    Void,
    Task,
    GenericTask,
    AsyncIterator,
    Custom
}
