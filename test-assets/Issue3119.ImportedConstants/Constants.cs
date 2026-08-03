// <copyright file="Constants.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Issue3119.Same;

/// <summary>Top-level enum for an enum-typed literal field.</summary>
public enum TopLevelEnum
{
    /// <summary>Distinct corpus value.</summary>
    Value406 = 406,
}

/// <summary>Imported constant and nullable-field specimens for issue #3119.</summary>
public static class Constants
{
    /// <summary>Empty string constant.</summary>
    public const string Empty = "";

    /// <summary>String constant containing newline, quote, and slash escapes.</summary>
    public const string Escaped = "A\n\"B\"\\C";

    /// <summary>Character constant.</summary>
    public const char Character = 'Q';

    /// <summary>Boolean constant.</summary>
    public const bool Boolean = true;

    /// <summary>Decimal constant, encoded through DecimalConstantAttribute metadata.</summary>
    public const decimal Decimal = 405.5m;

    /// <summary>Top-level enum-typed constant.</summary>
    public const TopLevelEnum TopLevelEnumValue = TopLevelEnum.Value406;

    /// <summary>Nested enum-typed constant.</summary>
    public const NestedEnum NestedEnumValue = NestedEnum.Value407;

    /// <summary>Reference constant proving the requested assembly was loaded.</summary>
    public const int PositiveControl = 499;

    /// <summary>Nullable reference field under enabled annotations.</summary>
    public static readonly string? EnabledText = "enabled-text-410";

    /// <summary>Nullable value field under enabled annotations.</summary>
    public static readonly int? EnabledInt = 411;

#nullable disable
#pragma warning disable CS8632

    /// <summary>Nullable reference field under disabled nullable context.</summary>
    public static readonly string? DisabledText = "disabled-text-412";

    /// <summary>Nullable value field under disabled nullable context.</summary>
    public static readonly int? DisabledInt = 413;

#pragma warning restore CS8632
#nullable enable

    /// <summary>Nested enum for an enum-typed literal field.</summary>
    public enum NestedEnum
    {
        /// <summary>Distinct corpus value.</summary>
        Value407 = 407,
    }
}

/// <summary>Generic declaring type for depth-2 and depth-3 constant access.</summary>
/// <typeparam name="TOuter">Outer generic argument.</typeparam>
public static class GenericOuter<TOuter>
{
    /// <summary>Depth-2 declaring type under a generic outer.</summary>
    public static class Depth2
    {
        /// <summary>Distinct depth-2 value.</summary>
        public const int Value = 408;

        /// <summary>Depth-3 declaring type under a generic outer.</summary>
        public static class Depth3
        {
            /// <summary>Distinct depth-3 value.</summary>
            public const string Value = "depth3-409";
        }
    }
}
