// <copyright file="BuiltInCodeFixProviders.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import System.Collections.Immutable

/// The built-in providers for compiler diagnostics, in registry order (ADR-0227 D2, D8).
internal shared class BuiltInCodeFixProviders {
    /// Creates the built-in providers.
    /// @returns The providers, in source order.
    func Create() ImmutableArray[GSharpCodeFixProvider] -> ImmutableArray[GSharpCodeFixProvider].Empty
}
