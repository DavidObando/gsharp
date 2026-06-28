#nullable disable

// <copyright file="NullabilityAnnotatedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A <see cref="TypeSymbol"/> that wraps an imported CLR generic type and carries
/// the full <c>[NullableAttribute]</c> byte array so that inner-position
/// generic-argument nullability (issue #209) can be recovered when the type is
/// later used as a collection element, dictionary value, etc.
/// </summary>
/// <remarks>
/// <para>
/// The <see cref="NullableFlags"/> array follows the C# compiler's DFS pre-order
/// layout: byte 0 belongs to the outer type itself (always a reference type when
/// this wrapper is created), and subsequent bytes belong to each generic type
/// argument in order — recursively, for nested generics — skipping value-type
/// positions (which carry no reference-nullability byte).
/// </para>
/// <para>
/// Example — <c>Dictionary&lt;string, string?&gt;</c>:<br/>
/// flags = { 1 (Dictionary non-null), 1 (string key non-null), 2 (string? value nullable) }.
/// </para>
/// </remarks>
public sealed class NullabilityAnnotatedTypeSymbol : TypeSymbol
{
    internal NullabilityAnnotatedTypeSymbol(TypeSymbol baseType, ImmutableArray<byte> nullableFlags)
        : base(baseType.Name, baseType.ClrType)
    {
        BaseType = baseType;
        NullableFlags = nullableFlags;
    }

    /// <summary>Gets the underlying non-annotated type symbol.</summary>
    public TypeSymbol BaseType { get; }

    /// <summary>
    /// Gets the full <c>[NullableAttribute]</c> byte array for this type, starting
    /// at the outer type's own byte (index 0).
    /// </summary>
    public ImmutableArray<byte> NullableFlags { get; }

    /// <summary>
    /// Returns the <see cref="TypeSymbol"/> for the generic type argument at
    /// <paramref name="argIndex"/> (0-based), with reference nullability applied
    /// from <see cref="NullableFlags"/>.
    /// </summary>
    /// <param name="argIndex">0-based index into the outer CLR type's generic arguments.</param>
    /// <returns>
    /// The properly-nullified symbol, or <see cref="TypeSymbol.Error"/> when the
    /// outer CLR type is not a closed generic.
    /// </returns>
    public TypeSymbol GetTypeArgumentSymbol(int argIndex)
    {
        var clr = ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return TypeSymbol.Error;
        }

        var args = clr.GetGenericArguments();
        if ((uint)argIndex >= (uint)args.Length)
        {
            return TypeSymbol.Error;
        }

        // Byte 0 belongs to the outer type itself (a reference type).
        int offset = 1;
        for (int i = 0; i < argIndex; i++)
        {
            offset += ClrNullability.CountNullabilityBytes(args[i]);
        }

        return ClrNullability.SymbolFromFlagsOffset(args[argIndex], NullableFlags, offset);
    }

    /// <summary>
    /// Searches the outer type's generic arguments for one whose resolved CLR type
    /// matches <paramref name="targetClrType"/> and returns a properly-nullified
    /// <see cref="TypeSymbol"/> for it. Falls back to a plain
    /// <see cref="TypeSymbol.FromClrType"/> result when no matching argument is found.
    /// </summary>
    /// <param name="targetClrType">The CLR element type to locate.</param>
    /// <returns>The nullified symbol for the first matching argument.</returns>
    public TypeSymbol GetTypeArgumentSymbolForClrType(Type targetClrType)
    {
        if (targetClrType == null)
        {
            return TypeSymbol.Error;
        }

        var clr = ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return TypeSymbol.FromClrType(targetClrType);
        }

        var args = clr.GetGenericArguments();
        int offset = 1; // byte 0 = outer type

        for (int i = 0; i < args.Length; i++)
        {
            var arg = args[i];

            // Compare by FullName so MetadataLoadContext types match runtime types.
            if (arg == targetClrType || (!arg.IsGenericParameter && arg.FullName == targetClrType.FullName))
            {
                return ClrNullability.SymbolFromFlagsOffset(arg, NullableFlags, offset);
            }

            offset += ClrNullability.CountNullabilityBytes(arg);
        }

        return TypeSymbol.FromClrType(targetClrType);
    }
}
