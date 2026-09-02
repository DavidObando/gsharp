// <copyright file="RetiredBuiltins.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D12/D13: the replacement each retired Go-style built-in gets in a
/// GS0566 message. The guidance is computed for the site — it names the
/// author's own operand text and the member the operand's type actually has
/// (<c>.Count</c> for a map, <c>.Length()</c> for a channel, <c>.Length</c>
/// otherwise) — so pasting it in place of the retired call compiles.
/// </summary>
internal static class RetiredBuiltins
{
    /// <summary>The retired built-in names, in the order the ADR lists them.</summary>
    public static readonly ImmutableArray<string> Names = ImmutableArray.Create("len", "cap", "append", "delete", "close");

    /// <summary>
    /// Builds the guidance clause of a GS0566 message for a retired built-in call.
    /// </summary>
    /// <param name="name">The retired built-in's name.</param>
    /// <param name="receiverType">The bound type of the first argument, when there is one.</param>
    /// <param name="argumentTexts">The source text of each argument.</param>
    /// <returns>The guidance clause, ending in a period.</returns>
    public static string GetReplacementGuidance(string name, TypeSymbol? receiverType, ImmutableArray<string> argumentTexts)
    {
        var receiver = argumentTexts.Length > 0 ? argumentTexts[0] : "x";
        var isChannel = receiverType != null && ChannelTypeSymbol.TryGetChannelShape(receiverType, out _, out _, out _);
        switch (name)
        {
            case "len":
                if (receiverType is MapTypeSymbol)
                {
                    return $"use '{receiver}.Count' instead.";
                }

                return isChannel
                    ? $"use '{receiver}.Length()' instead."
                    : $"use '{receiver}.Length' instead.";

            case "cap":
                return isChannel
                    ? $"use '{receiver}.Capacity' instead."
                    : $"'cap' has no replacement: a slice ('[]T') is a fixed CLR array whose capacity is its length, '{receiver}.Length'.";

            case "append":
            {
                var element = argumentTexts.Length > 1 ? argumentTexts[1] : "v";
                return $"a slice ('[]T') is a fixed CLR array; keep a growable 'List[T]' and call '{receiver}.Add({element})' instead.";
            }

            case "delete":
            {
                var key = argumentTexts.Length > 1 ? argumentTexts[1] : "k";
                return $"use '{receiver}.Remove({key})' instead.";
            }

            case "close":
                return $"use '{receiver}.Close()' instead.";

            default:
                return "it has no replacement.";
        }
    }
}
