// <copyright file="ResxTypeNameMapper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Resx

import System
import System.Collections.Generic
import System.Text

/// Maps a resx `type` attribute — an assembly-qualified CLR type name
/// such as `System.Byte[], mscorlib, Version=4.0.0.0, ...` — to a G#
/// type clause (ADR-0142). G# resolves an arbitrary dotted CLR type name
/// directly (no `import` required), so only two transforms are needed:
/// strip the trailing assembly qualification, and rewrite CLR primitive
/// element names / the C# `T[]` array suffix to their G# spellings
/// (`uint8`, `[]T`, ...). Non-primitive leaf types (e.g.
/// `System.Drawing.Bitmap`) are passed through unchanged as a
/// fully-qualified dotted type reference.
shared class ResxTypeNameMapper {
    private let PrimitiveMap Dictionary[string, string] = Dictionary[string, string]{
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
        ["System.Object"] = "object"
    }

    /// Maps an assembly-qualified resx `type` attribute to the G# type
    /// clause a property getter should cast/downcast the resource value to.
    /// @param assemblyQualifiedTypeName The resx `type` attribute, e.g.
    /// `System.Byte[], mscorlib, Version=4.0.0.0, ...`.
    /// @returns The equivalent G# type clause, e.g. `[]uint8`.
    func Map(assemblyQualifiedTypeName string) string {
        // The assembly qualification starts at the first ", " that follows
        // the type name (e.g. ", mscorlib, Version=..., Culture=..., PublicKeyToken=...").
        // Generic CLR type names can themselves embed commas inside a `[...]`
        // argument list; that combination is rare in practice for resx
        // payloads and is a documented limitation (ADR-0142).
        var clrName = assemblyQualifiedTypeName
        let comma = clrName.IndexOf(',')
        if comma >= 0 {
            clrName = clrName.Substring(0, comma)
        }
        clrName = clrName.Trim()
        var arity = 0
        while clrName.EndsWith("[]", StringComparison.Ordinal) {
            arity++
            clrName = clrName.Substring(0, clrName.Length - 2)
        }
        let leaf = if PrimitiveMap.TryGetValue(clrName, out var mapped) {
            mapped
        } else {
            clrName
        }
        let prefix = StringBuilder(arity * 2)
        for var i = 0; i < arity; i++ {
            prefix.Append("[]")
        }
        return prefix.Append(leaf).ToString()
    }
}
