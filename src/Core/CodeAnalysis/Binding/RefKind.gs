// <copyright file="RefKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

/// Describes the by-reference passing mode of a parameter or argument at a CLR call site.
enum RefKind {
    None,
    Ref,
    Out,
    In,
    RefReadOnly
}
