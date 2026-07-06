// <copyright file="ResxTypeNameMapper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace GSharp.Core.Resx;

/// <summary>
/// Maps a resx <c>type</c> attribute — an assembly-qualified CLR type name
/// such as <c>System.Byte[], mscorlib, Version=4.0.0.0, ...</c> — to a G#
/// type clause (ADR-0142). G# resolves an arbitrary dotted CLR type name
/// directly (no <c>import</c> required), so only two transforms are needed:
/// strip the trailing assembly qualification, and rewrite CLR primitive
/// element names / the C# <c>T[]</c> array suffix to their G# spellings
/// (<c>uint8</c>, <c>[]T</c>, ...). Non-primitive leaf types (e.g.
/// <c>System.Drawing.Bitmap</c>) are passed through unchanged as a
/// fully-qualified dotted type reference.
/// </summary>
public static class ResxTypeNameMapper
{
    private static readonly Dictionary<string, string> PrimitiveMap = new Dictionary<string, string>
    {
        ["System.Boolean"] = "bool",
        ["System.Byte"] = "uint8",
        ["System.SByte"] = "int8",
        ["System.Int16"] = "int16",
        ["System.UInt16"] = "uint16",
        ["System.Int32"] = "int32",
        ["System.UInt32"] = "uint32",
        ["System.Int64"] = "int64",
        ["System.UInt64"] = "uint64",
        ["System.Single"] = "float32",
        ["System.Double"] = "float64",
        ["System.Decimal"] = "decimal",
        ["System.Char"] = "char",
        ["System.String"] = "string",
        ["System.Object"] = "object",
    };

    /// <summary>
    /// Maps an assembly-qualified resx <c>type</c> attribute to the G# type
    /// clause a property getter should cast/downcast the resource value to.
    /// </summary>
    /// <param name="assemblyQualifiedTypeName">
    /// The resx <c>type</c> attribute, e.g. <c>System.Byte[], mscorlib, Version=4.0.0.0, ...</c>.
    /// </param>
    /// <returns>The equivalent G# type clause, e.g. <c>[]uint8</c>.</returns>
    public static string Map(string assemblyQualifiedTypeName)
    {
        // The assembly qualification starts at the first ", " that follows
        // the type name (e.g. ", mscorlib, Version=..., Culture=..., PublicKeyToken=...").
        // Generic CLR type names can themselves embed commas inside a `[...]`
        // argument list; that combination is rare in practice for resx
        // payloads and is a documented limitation (ADR-0142).
        string clrName = assemblyQualifiedTypeName;
        int comma = clrName.IndexOf(',');
        if (comma >= 0)
        {
            clrName = clrName.Substring(0, comma);
        }

        clrName = clrName.Trim();

        int arity = 0;
        while (clrName.EndsWith("[]", System.StringComparison.Ordinal))
        {
            arity++;
            clrName = clrName.Substring(0, clrName.Length - 2);
        }

        string leaf = PrimitiveMap.TryGetValue(clrName, out var mapped) ? mapped : clrName;

        var prefix = new System.Text.StringBuilder(arity * 2);
        for (int i = 0; i < arity; i++)
        {
            prefix.Append("[]");
        }

        return prefix.Append(leaf).ToString();
    }
}
