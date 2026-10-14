// <copyright file="AttributeTargetKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

/// Closed set of attribute use-site target kinds per ADR-0047 §2.
enum AttributeTargetKind {
    Field,
    Param,
    Return,
    Type,
    Method,
    Property,
    Event,
    Module,
    Assembly,
    GenericParam
}
