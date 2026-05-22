// <copyright file="StructValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Interpreter-side representation of a user-defined struct value (Phase 3.B.1).
/// The emit backend uses native CLR value types; this class only exists so the
/// tree-walking <see cref="Evaluator"/> can carry struct values around with
/// Go-style value semantics (assignment and field writes go through copies).
/// </summary>
public sealed class StructValue
{
    /// <summary>Initializes a new instance of the <see cref="StructValue"/> class.</summary>
    /// <param name="structType">The struct type symbol.</param>
    public StructValue(StructSymbol structType)
    {
        StructType = structType;
        Fields = new Dictionary<string, object>();
    }

    private StructValue(StructSymbol structType, Dictionary<string, object> fields)
    {
        StructType = structType;
        Fields = fields;
    }

    /// <summary>Gets the struct type.</summary>
    public StructSymbol StructType { get; }

    /// <summary>Gets the mutable field dictionary backing this instance.</summary>
    public Dictionary<string, object> Fields { get; }

    /// <summary>Creates a shallow copy of this struct value (value-semantics).</summary>
    /// <returns>A new instance with the same fields.</returns>
    public StructValue Copy()
    {
        var copy = new Dictionary<string, object>(Fields.Count);
        foreach (var kvp in Fields)
        {
            copy[kvp.Key] = kvp.Value is StructValue inner ? inner.Copy() : kvp.Value;
        }

        return new StructValue(StructType, copy);
    }
}
