// <copyright file="BindingKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Binding mutability keyword for fields and local declarations
/// (ADR-0008/ADR-0067, ADR-0115 §B.3).
/// </summary>
public enum BindingKind
{
    /// <summary>An immutable binding (<c>let</c>).</summary>
    Let,

    /// <summary>A mutable binding (<c>var</c>).</summary>
    Var,

    /// <summary>A compile-time constant (<c>const</c>).</summary>
    Const,

    /// <summary>
    /// A fixed-size buffer field (<c>fixed name [N]T</c>), ADR-0122 §10. Only
    /// valid as a <see cref="FieldDeclaration.Binding"/> inside an unsafe
    /// struct; renders without a <c>var</c>/<c>let</c>/<c>const</c> keyword.
    /// </summary>
    FixedBuffer,
}
