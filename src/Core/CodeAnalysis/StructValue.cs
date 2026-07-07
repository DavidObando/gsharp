// <copyright file="StructValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
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
        Fields = new ConcurrentDictionary<string, object>();
    }

    private StructValue(StructSymbol structType, ConcurrentDictionary<string, object> fields)
    {
        StructType = structType;
        Fields = fields;
    }

    /// <summary>Gets the struct type.</summary>
    public StructSymbol StructType { get; }

    // Issue #1718: class-typed StructValue instances (Evaluator.Assign skips
    // Copy() for IsClass structs) are shared by reference, including the
    // heap "box" cells CaptureBoxingRewriter synthesizes for a mutable
    // variable captured by a function literal (isClass: true). Any number
    // of goroutines that received the same class instance/box (as an
    // argument, a captured variable, or a field) can write distinct fields
    // on it at the same time, so this dictionary needs the same
    // concurrent-write safety as an interpreter locals frame. Plain
    // Dictionary&lt;,&gt; is not thread-safe under concurrent writes.

    /// <summary>Gets the mutable field dictionary backing this instance.</summary>
    public ConcurrentDictionary<string, object> Fields { get; }

    /// <summary>
    /// Gets or sets the CLR backing instance for a GSharp class that inherits an
    /// imported CLR base type (issue #319). When non-null, the interpreter routes
    /// reflection-based access to inherited CLR instance state (properties, fields,
    /// methods) through this real CLR object so the base constructor's side-effects
    /// (e.g. <see cref="System.Exception.Message"/>) are observable. Always null
    /// for value-type structs and for class instances whose ultimate base is
    /// <c>object</c> or another GSharp class.
    /// </summary>
    public object ClrBacking { get; set; }

    /// <summary>Creates a shallow copy of this struct value (value-semantics).</summary>
    /// <returns>A new instance with the same fields.</returns>
    public StructValue Copy()
    {
        var copy = new ConcurrentDictionary<string, object>();
        foreach (var kvp in Fields)
        {
            copy[kvp.Key] = kvp.Value is StructValue inner ? inner.Copy() : kvp.Value;
        }

        return new StructValue(StructType, copy)
        {
            // Issue #319: copy carries the same CLR backing reference. A copy is
            // only ever created for value-type structs (Evaluator.Assign skips it
            // for classes), so the backing is expected to be null here; we copy
            // it defensively for symmetry.
            ClrBacking = this.ClrBacking,
        };
    }

    /// <inheritdoc/>
    public override bool Equals(object obj)
    {
        if (obj is not StructValue other)
        {
            return false;
        }

        if (StructType != other.StructType)
        {
            return false;
        }

        foreach (var (_, storageKey) in GetDisplayMembers(StructType))
        {
            Fields.TryGetValue(storageKey, out var lv);
            other.Fields.TryGetValue(storageKey, out var rv);
            if (!object.Equals(lv, rv))
            {
                return false;
            }
        }

        return true;
    }

    /// <inheritdoc/>
    public override int GetHashCode()
    {
        var hash = default(HashCode);
        hash.Add(StructType);
        foreach (var (_, storageKey) in GetDisplayMembers(StructType))
        {
            Fields.TryGetValue(storageKey, out var v);
            hash.Add(v);
        }

        return hash.ToHashCode();
    }

    /// <inheritdoc/>
    public override string ToString()
    {
        var sb = new StringBuilder();
        sb.Append(StructType.Name).Append('(');
        var first = true;
        foreach (var (displayName, storageKey) in GetDisplayMembers(StructType))
        {
            if (!first)
            {
                sb.Append(", ");
            }

            first = false;
            Fields.TryGetValue(storageKey, out var v);
            sb.Append(displayName).Append('=');
            sb.Append(v is null ? "nil" : System.Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        sb.Append(')');
        return sb.ToString();
    }

    // Rubber-duck follow-up to issue #2224: an anonymous-class literal's
    // synthesized type exposes get-only auto-properties, not plain fields
    // (see AnonymousTypeCache); its runtime storage in Fields lives under
    // the property's backing-field name. Ordinary structs/classes keep
    // Fields non-empty and are unaffected.
    private static System.Collections.Generic.IEnumerable<(string DisplayName, string StorageKey)> GetDisplayMembers(StructSymbol type)
    {
        if (!type.Fields.IsDefaultOrEmpty)
        {
            foreach (var field in type.Fields)
            {
                yield return (field.Name, field.Name);
            }

            yield break;
        }

        foreach (var property in type.Properties)
        {
            if (property.IsAutoProperty && property.BackingField != null)
            {
                yield return (property.Name, property.BackingField.Name);
            }
        }
    }
}
