// <copyright file="MemberKinds.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System

/// ADR-0112: the member kinds a (cref:MemberQuery) can request from the
/// canonical member-resolution layer ((cref:TypeMemberModel)).
@System.Flags
enum MemberKinds {
    None,
    Field,
    Property,
    Event = 4,
    Method = 8,
    NestedType = 16,
    All = 15
}
