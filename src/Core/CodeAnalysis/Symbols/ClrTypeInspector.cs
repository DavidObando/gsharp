// <copyright file="ClrTypeInspector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using System.Reflection.Emit;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Provides stable CLR entry points for reflected-type inspection.
/// </summary>
public static class ClrTypeInspector
{
    /// <summary>
    /// Compares reflected types across runtime and metadata load contexts.
    /// </summary>
    /// <param name="left">The first type.</param>
    /// <param name="right">The second type.</param>
    /// <returns>Whether the types represent the same CLR type.</returns>
    public static bool IsSameAs(Type left, Type right)
    {
        return left.IsSameAs(right);
    }

    /// <summary>
    /// Finds a method while supporting constructed <see cref="TypeBuilder"/> types.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <param name="name">The method name.</param>
    /// <returns>The method, or <see langword="null"/> when none matches.</returns>
    public static MethodInfo? GetMethodSafe(Type type, string name)
    {
        return type.GetMethodSafe(name);
    }

    /// <summary>
    /// Finds a method by parameter types while supporting constructed
    /// <see cref="TypeBuilder"/> types.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <param name="name">The method name.</param>
    /// <param name="parameterTypes">The required parameter types.</param>
    /// <returns>The method, or <see langword="null"/> when none matches.</returns>
    public static MethodInfo? GetMethodSafe(Type type, string name, params Type[] parameterTypes)
    {
        return type.GetMethodSafe(name, parameterTypes);
    }
}
