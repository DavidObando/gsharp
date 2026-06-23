// <copyright file="Visibility.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Accessibility of a declaration. <see cref="Default"/> means "emit nothing";
/// the printer only renders a modifier when the accessibility differs from the
/// canonical default for that position (ADR-0115 §B.10).
/// </summary>
public enum Visibility
{
    /// <summary>The position's canonical default; the printer emits no modifier.</summary>
    Default,

    /// <summary>The <c>public</c> modifier.</summary>
    Public,

    /// <summary>The <c>internal</c> modifier.</summary>
    Internal,

    /// <summary>The <c>private</c> modifier.</summary>
    Private,

    /// <summary>The <c>protected</c> modifier (issue #950).</summary>
    Protected,
}
