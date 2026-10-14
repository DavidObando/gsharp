// <copyright file="BoundNodeWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System.IO

/// Provides a stable CLR entry point for bound-tree rendering.
shared class BoundNodeWriter {
    /// Writes a bound node using the compiler's standard rendering.
    /// @param node The bound node to render.
    /// @param writer The destination writer.
    func WriteTo(node BoundNode, writer TextWriter) {
        BoundNodePrinter.WriteTo(node, writer)
    }
}
