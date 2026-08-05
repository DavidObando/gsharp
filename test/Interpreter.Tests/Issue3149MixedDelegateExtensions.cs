// <copyright file="Issue3149MixedDelegateExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace GSharp.Interpreter.Tests.Issue3149Mixed;

/// <summary>Open generic extension candidate mixed with <see cref="List{T}.Add(T)"/>.</summary>
public static class Issue3149MixedDelegateExtensions
{
    /// <summary>Must lose to the closed instance <c>Add</c> candidate.</summary>
    public static void Add<T>(this List<Issue3149Greeter> callbacks, Func<T, int> callback) =>
        throw new InvalidOperationException("Open generic extension candidate was selected.");
}
