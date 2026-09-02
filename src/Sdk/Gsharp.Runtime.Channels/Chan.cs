// <copyright file="Chan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Static factories for the G#-owned channel type (ADR-0174 D1/D12). The
/// generic <c>Chan&lt;T&gt;</c> class is constructed from G# by the type
/// clause applied to arguments, <c>chan[T](n)</c>; this non-generic host
/// carries the one factory that has no such spelling, <c>Chan.Unbounded[T]()</c>.
/// </summary>
public static partial class Chan
{
}
