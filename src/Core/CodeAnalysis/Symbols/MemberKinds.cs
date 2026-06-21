// <copyright file="MemberKinds.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0112: the member kinds a <see cref="MemberQuery"/> can request from the
/// canonical member-resolution layer (<see cref="TypeMemberModel"/>).
/// </summary>
[System.Flags]
public enum MemberKinds
{
    /// <summary>No member kinds.</summary>
    None = 0,

    /// <summary>Instance / static fields.</summary>
    Field = 1,

    /// <summary>Instance / static properties.</summary>
    Property = 2,

    /// <summary>Instance / static events.</summary>
    Event = 4,

    /// <summary>Instance / static methods.</summary>
    Method = 8,

    /// <summary>Every member kind.</summary>
    All = Field | Property | Event | Method,
}
