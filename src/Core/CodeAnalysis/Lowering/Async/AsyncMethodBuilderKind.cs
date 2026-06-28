#nullable disable

// <copyright file="AsyncMethodBuilderKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Categorises the BCL async method builder selected for an <c>async</c>
/// method (see <c>~/roslyn-async.md</c> §1).
/// </summary>
public enum AsyncMethodBuilderKind
{
    /// <summary>The return type was unrecognised and no
    /// <c>[AsyncMethodBuilder]</c> attribute applied.</summary>
    Unknown,

    /// <summary><c>async void</c> — uses <c>AsyncVoidMethodBuilder</c>.</summary>
    Void,

    /// <summary><c>async Task</c> — uses <c>AsyncTaskMethodBuilder</c>.</summary>
    Task,

    /// <summary><c>async Task&lt;T&gt;</c> — uses
    /// <c>AsyncTaskMethodBuilder&lt;T&gt;</c>.</summary>
    GenericTask,

    /// <summary><c>async IAsyncEnumerable&lt;T&gt;</c> or
    /// <c>async IAsyncEnumerator&lt;T&gt;</c> — uses
    /// <c>AsyncIteratorMethodBuilder</c>. The state machine is always a class
    /// (spec §10).</summary>
    AsyncIterator,

    /// <summary>The return type or method carried a
    /// <c>[AsyncMethodBuilder(typeof(T))]</c> attribute. Examples:
    /// <c>ValueTask</c>, <c>ValueTask&lt;T&gt;</c>, user-defined task-likes.</summary>
    Custom,
}
