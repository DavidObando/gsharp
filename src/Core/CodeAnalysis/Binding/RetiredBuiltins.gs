// <copyright file="RetiredBuiltins.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable

/// ADR-0174 D12/D13: the replacement each retired Go-style built-in gets in a
/// GS0566 message. The guidance is computed for the site — it names the
/// author's own operand text and the member the operand's type actually has
/// (`.Count` for a map, `.Length()` for a channel, `.Length`
/// otherwise) — so pasting it in place of the retired call compiles.
internal shared class RetiredBuiltins {
    /// The retired built-in names, in the order the ADR lists them.
    let Names ImmutableArray[string] = ImmutableArray.Create("len", "cap", "append", "delete", "close")

    /// Builds the guidance clause of a GS0566 message for a retired built-in call.
    /// @param name The retired built-in's name.
    /// @param receiverType The bound type of the first argument, when there is one.
    /// @param argumentTexts The source text of each argument.
    /// @returns The guidance clause, ending in a period.
    func GetReplacementGuidance(name string, receiverType TypeSymbol?, argumentTexts ImmutableArray[string]) string {
        let receiver = if argumentTexts.Length > 0 {
            argumentTexts[0]
        } else {
            "x"
        }
        let isChannel = receiverType != nil && ChannelTypeSymbol.TryGetChannelShape(receiverType, out _, out _, out _)
        switch name {
            case "len" {
                if receiverType is MapTypeSymbol {
                    return "use '$receiver.Count' instead."
                }
                return if isChannel {
                    "use '$receiver.Length()' instead."
                } else {
                    "use '$receiver.Length' instead."
                }
            }
            case "cap" {
                return if isChannel {
                    "use '$receiver.Capacity' instead."
                } else {
                    "'cap' has no replacement: a slice ('[]T') is a fixed CLR array whose capacity is its length, '$receiver.Length'."
                }
            }
            case "append" {
                {
                    let element = if argumentTexts.Length > 1 {
                        argumentTexts[1]
                    } else {
                        "v"
                    }
                    return "a slice ('[]T') is a fixed CLR array; keep a growable 'List[T]' and call '$receiver.Add($element)' instead."
                }
            }
            case "delete" {
                {
                    let key = if argumentTexts.Length > 1 {
                        argumentTexts[1]
                    } else {
                        "k"
                    }
                    return "use '$receiver.Remove($key)' instead."
                }
            }
            case "close" {
                return "use '$receiver.Close()' instead."
            }
            default {
                return "it has no replacement."
            }
        }
    }
}
