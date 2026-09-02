// <copyright file="ChannelTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a channel type clause: <c>chan[T]</c>, <c>in chan[T]</c>, or
/// <c>out chan[T]</c> (ADR-0174 D1/D2).
/// </summary>
/// <remarks>
/// <para>The <em>type</em> stays identity-transparent to its BCL backing —
/// <c>chan[T]</c> is <c>System.Threading.Channels.Channel&lt;T&gt;</c>,
/// <c>in chan[T]</c> is <c>ChannelReader&lt;T&gt;</c>, <c>out chan[T]</c> is
/// <c>ChannelWriter&lt;T&gt;</c> — so every foreign channel from C# or NuGet
/// is assignable to it. What the <em>expression</em> <c>chan[T](…)</c>
/// constructs is the runtime's <c>Gsharp.Concurrency.Chan&lt;T&gt;</c>, a
/// subclass that carries the Go-exact machinery; that constructed type is
/// an ordinary imported symbol, and <see cref="TryGetChannelShape"/> is the
/// one place that recognizes every channel-shaped type.</para>
/// <para>Instances are cached per (element type, direction) so identical
/// channel types compare by reference.</para>
/// </remarks>
public sealed class ChannelTypeSymbol : TypeSymbol
{
    /// <summary>The full name of the runtime's constructed channel class.</summary>
    public const string ConstructedChannelFullName = "Gsharp.Concurrency.Chan`1";

    private const string ChannelFullName = "System.Threading.Channels.Channel`1";
    private const string ChannelReaderFullName = "System.Threading.Channels.ChannelReader`1";
    private const string ChannelWriterFullName = "System.Threading.Channels.ChannelWriter`1";

    private static readonly ConcurrentDictionary<(TypeSymbol Element, ChannelDirection Direction), ChannelTypeSymbol> Cache = new();

    private ChannelTypeSymbol(TypeSymbol elementType, ChannelDirection direction)

        // TypeSymbol's legacy CLR-type constructor accepts null for symbolic
        // same-compilation element types.
        : base(FormatName(elementType.Name, direction), MakeClrType(elementType, direction))
    {
        ElementType = elementType;
        Direction = direction;
    }

    /// <summary>Gets the channel element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>Gets the channel direction.</summary>
    public ChannelDirection Direction { get; }

    /// <summary>Gets a value indicating whether this is an <c>in chan[T]</c> (receive-only) handle.</summary>
    public bool IsReceiveOnly => Direction == ChannelDirection.In;

    /// <summary>Gets a value indicating whether this is an <c>out chan[T]</c> (send-only) handle.</summary>
    public bool IsSendOnly => Direction == ChannelDirection.Out;

    /// <summary>
    /// Gets or creates the bidirectional channel type symbol for the given element type.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <returns>The cached <see cref="ChannelTypeSymbol"/>.</returns>
    public static ChannelTypeSymbol Get(TypeSymbol elementType) => Get(elementType, ChannelDirection.Both);

    /// <summary>
    /// Gets or creates the channel type symbol for the given element type and direction.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The direction.</param>
    /// <returns>The cached <see cref="ChannelTypeSymbol"/>.</returns>
    public static ChannelTypeSymbol Get(TypeSymbol elementType, ChannelDirection direction)
    {
        if (elementType == null)
        {
            throw new ArgumentNullException(nameof(elementType));
        }

        return Cache.GetOrAdd((elementType, direction), static key => new ChannelTypeSymbol(key.Element, key.Direction));
    }

    /// <summary>
    /// Recognizes every channel-shaped type the operation matrix (ADR-0174 D2)
    /// covers: the magic <c>chan[T]</c> symbols, the runtime's constructed
    /// <c>Chan&lt;T&gt;</c>, and foreign BCL <c>Channel&lt;T&gt;</c> /
    /// <c>ChannelReader&lt;T&gt;</c> / <c>ChannelWriter&lt;T&gt;</c>. A nullable
    /// wrapper is looked through: a <c>nil</c> channel blocks forever, which is
    /// what makes disabled <c>select</c> arms work.
    /// </summary>
    /// <param name="type">The operand type.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The direction the handle permits.</param>
    /// <param name="isConstructed">True when the type is the runtime's <c>Chan&lt;T&gt;</c> (the fast path).</param>
    /// <returns>True when <paramref name="type"/> is channel-shaped.</returns>
    public static bool TryGetChannelShape(
        TypeSymbol? type,
        [NotNullWhen(true)] out TypeSymbol? elementType,
        out ChannelDirection direction,
        out bool isConstructed)
    {
        elementType = null;
        direction = ChannelDirection.Both;
        isConstructed = false;

        switch (type)
        {
            case null:
                return false;
            case NullableTypeSymbol nullable:
                return TryGetChannelShape(nullable.UnderlyingType, out elementType, out direction, out isConstructed);
            case NullabilityAnnotatedTypeSymbol annotated:
                return TryGetChannelShape(annotated.BaseType, out elementType, out direction, out isConstructed);
            case ChannelTypeSymbol channel:
                elementType = channel.ElementType;
                direction = channel.Direction;
                return true;
            case ImportedTypeSymbol imported:
            {
                var open = imported.OpenDefinition;
                if (open == null && imported.ClrType is { IsGenericType: true } closed)
                {
                    open = closed.GetGenericTypeDefinition();
                }

                switch (open?.FullName)
                {
                    case ConstructedChannelFullName:
                        isConstructed = true;
                        direction = ChannelDirection.Both;
                        break;
                    case ChannelFullName:
                        direction = ChannelDirection.Both;
                        break;
                    case ChannelReaderFullName:
                        direction = ChannelDirection.In;
                        break;
                    case ChannelWriterFullName:
                        direction = ChannelDirection.Out;
                        break;
                    default:
                        return false;
                }

                if (!imported.TypeArguments.IsDefaultOrEmpty)
                {
                    elementType = imported.TypeArguments[0];
                    return true;
                }

                if (imported.ClrType is { IsGenericType: true } closedShape)
                {
                    elementType = FromClrType(closedShape.GetGenericArguments()[0]);
                    return elementType != null;
                }

                return false;
            }

            default:
                return false;
        }
    }

    /// <summary>Gets the open BCL generic definition a direction binds to.</summary>
    /// <param name="direction">The direction.</param>
    /// <returns><c>Channel&lt;&gt;</c>, <c>ChannelReader&lt;&gt;</c>, or <c>ChannelWriter&lt;&gt;</c>.</returns>
    internal static Type OpenClrDefinition(ChannelDirection direction) => direction switch
    {
        ChannelDirection.In => typeof(ChannelReader<>),
        ChannelDirection.Out => typeof(ChannelWriter<>),
        _ => typeof(Channel<>),
    };

    /// <summary>Formats the G# spelling of a channel type over an already-formatted element.</summary>
    /// <param name="elementText">The element type's display text.</param>
    /// <param name="direction">The direction.</param>
    /// <returns>The spelling.</returns>
    internal static string FormatName(string elementText, ChannelDirection direction) => direction switch
    {
        ChannelDirection.In => $"in chan[{elementText}]",
        ChannelDirection.Out => $"out chan[{elementText}]",
        _ => $"chan[{elementText}]",
    };

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    private static Type? MakeClrType(TypeSymbol elementType, ChannelDirection direction)
    {
        if (elementType.ClrType == null)
        {
            return null;
        }

        return OpenClrDefinition(direction).MakeGenericType(elementType.ClrType);
    }
}
