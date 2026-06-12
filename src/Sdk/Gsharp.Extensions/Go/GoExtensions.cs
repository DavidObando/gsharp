// <copyright file="GoExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Extensions.Go;

/// <summary>
/// Marker type that makes the <see cref="Gsharp.Extensions.Go"/> namespace
/// resolvable to consumers that write <c>import Gsharp.Extensions.Go</c>.
/// </summary>
/// <remarks>
/// ADR-0082 / issue #722. The Go-flavored concurrency surface (the
/// <c>go</c> statement, <c>chan T</c> type, <c>&lt;-</c> send / receive
/// operators, <c>select</c> statement, <c>close(ch)</c> built-in, and
/// <c>make(chan T)</c> constructor) is compiler-built-in: the binder
/// gates each form on a per-file <c>import Gsharp.Extensions.Go</c>.
/// The library side contributes channel-related helpers in follow-up
/// issues (#723 Go-style built-ins, #724 helper namespaces); the
/// marker class here lets the namespace round-trip through
/// <see cref="System.Type"/>-based reference resolution and ensures the
/// assembly carries at least one public type so it is published and
/// referenced normally.
/// </remarks>
public static class GoExtensions
{
}
