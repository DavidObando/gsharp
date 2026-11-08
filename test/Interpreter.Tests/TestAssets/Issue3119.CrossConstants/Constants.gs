// <copyright file="Constants.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Issue3119.Cross

/// Top-level enum for an enum-typed literal field.
enum TopLevelEnum {
    Value406 = 406
}

/// Imported constant and nullable-field specimens for issue #3119.
shared class Constants {
    /// Nested enum for an enum-typed literal field.
    enum NestedEnum {
        Value407 = 407
    }

    /// Empty string constant.
    const Empty string = ""

    /// String constant containing newline, quote, and slash escapes.
    const Escaped string = "A\n\"B\"\\C"

    /// Character constant.
    const Character char = 'Q'

    /// Boolean constant.
    const Boolean bool = true

    /// Decimal constant, encoded through DecimalConstantAttribute metadata.
    const Decimal decimal = 405.5m

    /// Nullable-annotated string constant.
    const NullableConst string? = "nullable-const-414"

    /// Top-level enum-typed constant.
    const TopLevelEnumValue TopLevelEnum = TopLevelEnum.Value406

    /// Nested enum-typed constant.
    const NestedEnumValue NestedEnum = NestedEnum.Value407

    /// Reference constant proving the requested assembly was loaded.
    const PositiveControl int32 = 499

    /// Nullable reference field under enabled annotations.
    let EnabledText string? = "enabled-text-410"

    /// Nullable value field under enabled annotations.
    let EnabledInt int32? = 411

    /// Nullable reference field under disabled nullable context.
    let DisabledText string? = "disabled-text-412"

    /// Nullable value field under disabled nullable context.
    let DisabledInt int32? = 413
}

/// Generic declaring type for depth-2 and depth-3 constant access.
/// @typeparam TOuter Outer generic argument.
shared class GenericOuter[TOuter] {
    /// Depth-2 declaring type under a generic outer.
    shared class Depth2 {
        /// Depth-3 declaring type under a generic outer.
        shared class Depth3 {
            /// Distinct depth-3 value.
            const Value string = "depth3-409"
        }

        /// Distinct depth-2 value.
        const Value int32 = 408
    }
}
