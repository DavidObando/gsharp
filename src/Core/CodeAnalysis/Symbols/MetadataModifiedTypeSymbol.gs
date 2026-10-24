// <copyright file="MetadataModifiedTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// One custom modifier of a position: the modifier type and whether it is required (`modreq`) or optional (`modopt`).
internal class MetadataCustomModifier {
    internal init(type TypeSymbol, isRequired bool) {
        Type = type
        IsRequired = isRequired
    }

    internal prop Type TypeSymbol

    internal prop IsRequired bool
}

/// A position type with the custom modifiers that its signature blob puts before it (ADR-0209 section 6, row "Custom modifiers").
/// @remarks The modifiers are data beside the type. They keep blob order, first modifier first. The type itself is
/// (cref:Unmodified), and every identity question about the type asks the unmodified type
/// (see (cref:MetadataModifiers.Strip)).
internal class MetadataModifiedTypeSymbol : TypeSymbol {
    internal init(unmodified TypeSymbol, modifiers ImmutableArray[MetadataCustomModifier]) : base(unmodified.Name) {
        Unmodified = unmodified
        Modifiers = modifiers
    }

    /// Gets the type without its modifiers. It is never itself a modified type.
    internal prop Unmodified TypeSymbol

    /// Gets the modifiers, in blob order.
    internal prop Modifiers ImmutableArray[MetadataCustomModifier]
}

/// The rules for custom modifiers. Each rule is decided here once, for the decoder, the keys and the comparison.
internal shared class MetadataModifiers {
    private let CallConvPrefix string = "System.Runtime.CompilerServices.CallConv"

    /// Adds one modifier in front of a type. The decoder applies the modifiers of a position from the last to the first,
    /// so adding in front gives blob order.
    internal func Add(modifier TypeSymbol, isRequired bool, type TypeSymbol) TypeSymbol {
        let entry = MetadataCustomModifier(modifier, isRequired)
        if type is MetadataModifiedTypeSymbol modified {
            return MetadataModifiedTypeSymbol(modified.Unmodified, modified.Modifiers.Insert(0, entry))
        }
        return MetadataModifiedTypeSymbol(type, ImmutableArray.Create(entry))
    }

    /// Gets the type without its modifiers.
    internal func Strip(type TypeSymbol) TypeSymbol -> if type is MetadataModifiedTypeSymbol modified {
        modified.Unmodified
    } else {
        type
    }

    /// Gets the modifiers of a position type, in blob order. A type without modifiers has none.
    internal func Of(type TypeSymbol) ImmutableArray[
        MetadataCustomModifier
    ] -> if type is MetadataModifiedTypeSymbol modified {
        modified.Modifiers
    } else {
        ImmutableArray[MetadataCustomModifier].Empty
    }

    /// Tells whether a modifier type names a calling convention (`System.Runtime.CompilerServices.CallConv*`).
    internal func IsCallingConvention(type TypeSymbol) bool {
        let name = MetadataTypeKeys.Of(type)
        let separator = name.IndexOf('!')
        return separator >= 0 && name.Substring(separator + 1).StartsWith(CallConvPrefix, StringComparison.Ordinal)
    }

    /// Gets the calling convention modifiers of a function pointer, from the modifiers of its return type, in blob order.
    /// This is the data that the adapter maps onto the unmanaged conventions of (cref:FunctionPointerTypeSymbol).
    internal func CallingConventions(returnType TypeSymbol) ImmutableArray[TypeSymbol] {
        let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
        for modifier in Of(returnType) {
            if IsCallingConvention(modifier.Type) {
                builder.Add(modifier.Type)
            }
        }
        return builder.ToImmutable()
    }

    /// Tells whether any modifier type is, or contains, a missing type.
    internal func ContainsMissing(type TypeSymbol) bool {
        for modifier in Of(type) {
            if MetadataTypeKeys.ContainsMissing(modifier.Type) {
                return true
            }
        }
        return false
    }

    /// The one spelling of the modifiers of a position. Required and optional modifiers are listed apart, each in
    /// blob order, because reflection reports them apart. An unmodified position is the empty text.
    internal func Format(required IEnumerable[string], optionals IEnumerable[string]) string {
        let requiredText = string.Join(",", required)
        let optionalText = string.Join(",", optionals)
        return if requiredText.Length == 0 && optionalText.Length == 0 {
            ""
        } else {
            "{req:" + requiredText + ";opt:" + optionalText + "}"
        }
    }

    /// Spells the modifiers of a symbol position by the shared format.
    internal func Format(type TypeSymbol) string -> Format(
        Of(type).Where((m MetadataCustomModifier) -> m.IsRequired).Select(
            (m MetadataCustomModifier) -> MetadataTypeKeys.Of(m.Type)
        ),
        Of(type).Where((m MetadataCustomModifier) -> !m.IsRequired).Select(
            (m MetadataCustomModifier) -> MetadataTypeKeys.Of(m.Type)
        )
    )

    /// Spells the modifiers of a reflection position by the shared format.
    /// Reflection lists the modifiers of each kind in reverse blob order (observed with `MetadataLoadContext` on a
    /// field with `modopt(A) modreq(B) modopt(C)`, which reports the optional ones as C, A). The table is the truth,
    /// so the reflection lists are reversed here, and nowhere else.
    internal func Format(required[]Type, optionals[]Type) string -> Format(
        required.Reverse().Select((t Type) -> MetadataTypeKeys.Of(t)),
        optionals.Reverse().Select((t Type) -> MetadataTypeKeys.Of(t))
    )
}
