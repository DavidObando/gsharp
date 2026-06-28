#nullable disable

// <copyright file="AttributeTargetKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Closed set of attribute use-site target kinds per ADR-0047 §2.
/// </summary>
public enum AttributeTargetKind
{
    /// <summary>The annotation targets a field metadata row.</summary>
    Field,

    /// <summary>The annotation targets a parameter metadata row.</summary>
    Param,

    /// <summary>The annotation targets a return-value metadata row.</summary>
    Return,

    /// <summary>The annotation targets a type metadata row.</summary>
    Type,

    /// <summary>The annotation targets a method metadata row.</summary>
    Method,

    /// <summary>The annotation targets a property metadata row.</summary>
    Property,

    /// <summary>The annotation targets an event metadata row.</summary>
    Event,

    /// <summary>The annotation targets the module metadata row.</summary>
    Module,

    /// <summary>The annotation targets the assembly metadata row.</summary>
    Assembly,

    /// <summary>The annotation targets a generic parameter metadata row.</summary>
    GenericParam,
}
