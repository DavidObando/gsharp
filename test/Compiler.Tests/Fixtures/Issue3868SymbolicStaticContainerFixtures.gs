// <copyright file="Issue3868SymbolicStaticContainerFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Fixtures

/// Issue #3868 fixture: the base an in-source G# type derives from so it can
/// satisfy (cref:Issue3868Verifier{TA})'s type constraint. Shaped after
/// `GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer`, whose
/// verifier surfaced the defect in the migrated `test/Core.Tests`.
open class Issue3868Base {
    /// Gets the tag this instance contributes; overridden in G#.
    /// @returns The tag.
    open func Name() string -> "base"
}

/// Issue #3868 fixture: a generic static class whose type parameter carries
/// BOTH a base-type and a `new()` constraint — the shape of
/// `GSharpAnalyzerVerifier<TAnalyzer>`. The constraint is what turns
/// a type-erased `<object>` parent instantiation from a silent
/// mis-emit into an ilverify `UnsatisfiedMethodParentInst` and a runtime
/// `TypeLoadException`.
/// @typeparam TA The user type under test.
shared class Issue3868Verifier[TA Issue3868Base init()] {
    /// A fixed-arity static: already emitted correctly before #3868.
    /// @param s Any tag.
    /// @returns The recorded line.
    func Fixed(s string) string -> "fixed:" + TA().Name() + ":" + s

    /// The `params` shape the #1330 symbolic path declined.
    /// @param s Any tag.
    /// @param ids Trailing variadic tags.
    /// @returns The recorded line.
    func Variadic(s string, ids ...string) string -> "variadic:" + TA().Name() + ":" + s + ":" + ids.Length.ToString()

    /// The defaulted-parameter shape the #1330 symbolic path declined.
    /// @param s Any tag.
    /// @param t A defaulted tag.
    /// @returns The recorded line.
    func Defaulted(s string, t string = "d") string -> "defaulted:" + TA().Name() + ":" + s + ":" + t
}
