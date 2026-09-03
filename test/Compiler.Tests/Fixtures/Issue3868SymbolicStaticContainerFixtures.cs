// <copyright file="Issue3868SymbolicStaticContainerFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Compiler.Tests.Fixtures;

/// <summary>
/// Issue #3868 fixture: the base an in-source G# type derives from so it can
/// satisfy <see cref="Issue3868Verifier{TA}"/>'s type constraint. Shaped after
/// <c>GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer</c>, whose
/// verifier surfaced the defect in the migrated <c>test/Core.Tests</c>.
/// </summary>
public class Issue3868Base
{
    /// <summary>Gets the tag this instance contributes; overridden in G#.</summary>
    /// <returns>The tag.</returns>
    public virtual string Name() => "base";
}

/// <summary>
/// Issue #3868 fixture: a generic static class whose type parameter carries
/// BOTH a base-type and a <c>new()</c> constraint — the shape of
/// <c>GSharpAnalyzerVerifier&lt;TAnalyzer&gt;</c>. The constraint is what turns
/// a type-erased <c>&lt;object&gt;</c> parent instantiation from a silent
/// mis-emit into an ilverify <c>UnsatisfiedMethodParentInst</c> and a runtime
/// <c>TypeLoadException</c>.
/// </summary>
/// <typeparam name="TA">The user type under test.</typeparam>
public static class Issue3868Verifier<TA>
    where TA : Issue3868Base, new()
{
    /// <summary>A fixed-arity static: already emitted correctly before #3868.</summary>
    /// <param name="s">Any tag.</param>
    /// <returns>The recorded line.</returns>
    public static string Fixed(string s) => "fixed:" + new TA().Name() + ":" + s;

    /// <summary>The <c>params</c> shape the #1330 symbolic path declined.</summary>
    /// <param name="s">Any tag.</param>
    /// <param name="ids">Trailing variadic tags.</param>
    /// <returns>The recorded line.</returns>
    public static string Variadic(string s, params string[] ids)
        => "variadic:" + new TA().Name() + ":" + s + ":" + ids.Length;

    /// <summary>The defaulted-parameter shape the #1330 symbolic path declined.</summary>
    /// <param name="s">Any tag.</param>
    /// <param name="t">A defaulted tag.</param>
    /// <returns>The recorded line.</returns>
    public static string Defaulted(string s, string t = "d")
        => "defaulted:" + new TA().Name() + ":" + s + ":" + t;
}
