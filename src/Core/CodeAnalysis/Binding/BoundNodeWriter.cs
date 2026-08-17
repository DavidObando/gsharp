// <copyright file="BoundNodeWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Provides a stable CLR entry point for bound-tree rendering.
/// </summary>
public static class BoundNodeWriter
{
    /// <summary>
    /// Writes a bound node using the compiler's standard rendering.
    /// </summary>
    /// <param name="node">The bound node to render.</param>
    /// <param name="writer">The destination writer.</param>
    public static void WriteTo(BoundNode node, TextWriter writer)
    {
        node.WriteTo(writer);
    }
}
