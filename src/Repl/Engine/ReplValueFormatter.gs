// <copyright file="ReplValueFormatter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import System
import System.Collections
import System.Collections.Generic
import System.Globalization
import System.Reflection

/// ADR-0157: the display-side pretty-printer for REPL value echo. Renders a
/// value structurally in G# composite-literal shape
/// (`Name{Member: value, ...}`) when — and only when — its runtime type
/// has no `ToString` override below (cref:object) /
/// (cref:ValueType), and defers transparently to the real override
/// otherwise (synthesized `data` members, user
/// `override func ToString`, primitives, enums, imported CLR types).
/// @remarks The format is <b>diagnostics-only</b>: a tool affordance of the REPL, not
/// a language or spec guarantee — it may change in any release and programs
/// must not parse it. Emitted semantics are untouched by design (issue
/// #3204's decision): a plain struct or class still has no `ToString`
/// row, and compiled programs, interop, interpolation, and the debugger all
/// keep CLR behavior. See docs/adr/0157-default-tostring-synthesis.md.
///
/// Rendering contract (validated by the ADR-0157 spike and pinned by
/// `Adr0157ReplValueFormatterTests`): `nil` for null, quoted
/// strings/chars, overridden types via (cref:Convert.ToString(object, IFormatProvider))
/// invariant culture, element-wise capped collections, public instance
/// fields then public readable non-indexer properties in metadata order
/// (throwing getters render `<error>`), a recursion depth cap,
/// and reference-cycle elision — all elisions render as `...`.
shared class ReplValueFormatter {
    private const MaxDepth int32 = 4
    private const MaxElements int32 = 8
    private const Elision string = "..."

    /// Formats [`value`](paramref) for the REPL transcript echo and the
    /// state-sidebar values column.
    /// @param value The value to render; may be `null`.
    /// @returns The rendered text; never `null`.
    func Format(value object?) string -> Format(value, HashSet[object](ReferenceEqualityComparer.Instance), depth: 0)

    private func Format(value object?, path HashSet[object], depth int32) string {
        if value == nil {
            return "nil"
        }
        if value is string text {
            return "\"" + text + "\""
        }
        if value is char character {
            return "'" + character + "'"
        }
        let type = value.GetType()
        if HasToStringOverride(type) {
            // Any real override — synthesized data members, user overrides,
            // primitives, enums, imported CLR types — wins transparently,
            // matching CLR virtual dispatch.
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty
        }
        if depth >= MaxDepth {
            return Elision
        }
        // Reference-cycle guard: a reference value already on the current
        // rendering path elides instead of recursing forever.
        let track = !type.IsValueType
        if track && !path.Add(value) {
            return Elision
        }
        try {
            return if value is IEnumerable enumerable {
                FormatCollection(enumerable, path, depth)
            } else {
                FormatMembers(value, type, path, depth)
            }
        } finally {
            if track {
                path.Remove(value)
            }
        }
    }

    private func FormatMembers(value object, type Type, path HashSet[object], depth int32) string {
        let parts = List[string]()
        for field in type.GetFields(BindingFlags.Public | BindingFlags.Instance) {
            parts.Add(field.Name + ": " + Format(field.GetValue(value), path, depth + 1))
        }
        for property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
            if !property.CanRead || property.GetIndexParameters().Length != 0 {
                continue
            }
            var propertyValue object?
            try {
                propertyValue = property.GetValue(value)
            } catch (ex Exception) when ex is TargetInvocationException || ex is NotSupportedException {
                parts.Add(property.Name + ": <error>")
                continue
            }
            parts.Add(property.Name + ": " + Format(propertyValue, path, depth + 1))
        }
        return type.Name + "{" + string.Join(", ", parts) + "}"
    }

    private func FormatCollection(enumerable IEnumerable, path HashSet[object], depth int32) string {
        let parts = List[string]()
        var truncated = false
        for element in enumerable {
            if parts.Count == MaxElements {
                truncated = true
                break
            }
            parts.Add(Format(element, path, depth + 1))
        }
        return "[" + string.Join(", ", parts) +
            (
            if truncated {
                ", " + Elision
            } else {
                string.Empty
            }
        ) +
            "]"
    }

    private func HasToStringOverride(type Type) bool {
        let method MethodInfo? = type.GetMethod("ToString", Type.EmptyTypes)
        return method != nil && method.DeclaringType != typeof(object) && method.DeclaringType != typeof(ValueType)
    }
}
