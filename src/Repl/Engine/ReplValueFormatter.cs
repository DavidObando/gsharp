// <copyright file="ReplValueFormatter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;

namespace GSharp.Repl.Engine;

/// <summary>
/// ADR-0157: the display-side pretty-printer for REPL value echo. Renders a
/// value structurally in G# composite-literal shape
/// (<c>Name{Member: value, ...}</c>) when — and only when — its runtime type
/// has no <c>ToString</c> override below <see cref="object"/> /
/// <see cref="ValueType"/>, and defers transparently to the real override
/// otherwise (synthesized <c>data</c> members, user
/// <c>override func ToString</c>, primitives, enums, imported CLR types).
/// </summary>
/// <remarks>
/// <para>
/// The format is <b>diagnostics-only</b>: a tool affordance of the REPL, not
/// a language or spec guarantee — it may change in any release and programs
/// must not parse it. Emitted semantics are untouched by design (issue
/// #3204's decision): a plain struct or class still has no <c>ToString</c>
/// row, and compiled programs, interop, interpolation, and the debugger all
/// keep CLR behavior. See docs/adr/0157-default-tostring-synthesis.md.
/// </para>
/// <para>
/// Rendering contract (validated by the ADR-0157 spike and pinned by
/// <c>Adr0157ReplValueFormatterTests</c>): <c>nil</c> for null, quoted
/// strings/chars, overridden types via <see cref="Convert.ToString(object, IFormatProvider)"/>
/// invariant culture, element-wise capped collections, public instance
/// fields then public readable non-indexer properties in metadata order
/// (throwing getters render <c>&lt;error&gt;</c>), a recursion depth cap,
/// and reference-cycle elision — all elisions render as <c>...</c>.
/// </para>
/// </remarks>
public static class ReplValueFormatter
{
    private const int MaxDepth = 4;
    private const int MaxElements = 8;
    private const string Elision = "...";

    /// <summary>
    /// Formats <paramref name="value"/> for the REPL transcript echo and the
    /// state-sidebar values column.
    /// </summary>
    /// <param name="value">The value to render; may be <see langword="null"/>.</param>
    /// <returns>The rendered text; never <see langword="null"/>.</returns>
    public static string Format(object? value)
        => Format(value, new HashSet<object>(ReferenceEqualityComparer.Instance), depth: 0);

    private static string Format(object? value, HashSet<object> path, int depth)
    {
        if (value is null)
        {
            return "nil";
        }

        if (value is string text)
        {
            return "\"" + text + "\"";
        }

        if (value is char character)
        {
            return "'" + character + "'";
        }

        var type = value.GetType();
        if (HasToStringOverride(type))
        {
            // Any real override — synthesized data members, user overrides,
            // primitives, enums, imported CLR types — wins transparently,
            // matching CLR virtual dispatch.
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
        }

        if (depth >= MaxDepth)
        {
            return Elision;
        }

        // Reference-cycle guard: a reference value already on the current
        // rendering path elides instead of recursing forever.
        var track = !type.IsValueType;
        if (track && !path.Add(value))
        {
            return Elision;
        }

        try
        {
            return value is IEnumerable enumerable
                ? FormatCollection(enumerable, path, depth)
                : FormatMembers(value, type, path, depth);
        }
        finally
        {
            if (track)
            {
                path.Remove(value);
            }
        }
    }

    private static string FormatMembers(object value, Type type, HashSet<object> path, int depth)
    {
        var parts = new List<string>();
        foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            parts.Add(field.Name + ": " + Format(field.GetValue(value), path, depth + 1));
        }

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!property.CanRead || property.GetIndexParameters().Length != 0)
            {
                continue;
            }

            object? propertyValue;
            try
            {
                propertyValue = property.GetValue(value);
            }
            catch (Exception ex) when (ex is TargetInvocationException or NotSupportedException)
            {
                parts.Add(property.Name + ": <error>");
                continue;
            }

            parts.Add(property.Name + ": " + Format(propertyValue, path, depth + 1));
        }

        return type.Name + "{" + string.Join(", ", parts) + "}";
    }

    private static string FormatCollection(IEnumerable enumerable, HashSet<object> path, int depth)
    {
        var parts = new List<string>();
        var truncated = false;
        foreach (var element in enumerable)
        {
            if (parts.Count == MaxElements)
            {
                truncated = true;
                break;
            }

            parts.Add(Format(element, path, depth + 1));
        }

        return "[" + string.Join(", ", parts) + (truncated ? ", " + Elision : string.Empty) + "]";
    }

    private static bool HasToStringOverride(Type type)
    {
        var method = type.GetMethod("ToString", Type.EmptyTypes);
        return method is not null
            && method.DeclaringType != typeof(object)
            && method.DeclaringType != typeof(ValueType);
    }
}
