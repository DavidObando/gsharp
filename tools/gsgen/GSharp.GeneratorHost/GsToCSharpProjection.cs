// <copyright file="GsToCSharpProjection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §B facade: binds a G# <see cref="Compilation"/>'s global scope and
/// renders the declaration-only C# stub the generator host feeds to Roslyn.
/// <para>
/// <b>Tolerance rule (ADR-0145 §B).</b> Projection reads only the global-scope
/// symbol tables — never <c>BindProgram</c> — so it deliberately ignores
/// global-scope diagnostics (unresolved references in bodies/initializers do not
/// abort). Only the symbol declarations are consumed.
/// </para>
/// </summary>
public static class GsToCSharpProjection
{
    /// <summary>
    /// Projects the user-declared types of <paramref name="compilation"/> to a
    /// single declaration-only C# stub compilation unit.
    /// </summary>
    /// <param name="compilation">The G# compilation to project.</param>
    /// <returns>A C# compilation-unit string prefixed with <c>#nullable enable</c>.</returns>
    public static string ProjectToCSharp(Compilation compilation)
    {
        return ProjectToCSharp(compilation, out _);
    }

    /// <summary>
    /// Projects the user-declared types of <paramref name="compilation"/> to a
    /// single declaration-only C# stub compilation unit, exposing the renderer
    /// so callers can inspect type-spelling fallbacks (<c>GS9204</c>) and notes.
    /// </summary>
    /// <param name="compilation">The G# compilation to project.</param>
    /// <param name="renderer">The renderer that produced the stub, for fallback/note inspection.</param>
    /// <returns>A C# compilation-unit string prefixed with <c>#nullable enable</c>.</returns>
    public static string ProjectToCSharp(Compilation compilation, out GsStubRenderer renderer)
    {
        System.ArgumentNullException.ThrowIfNull(compilation);

        // Binding the global scope resolves declaration signatures and
        // attributes. Its diagnostics (which include not-yet-generated body
        // references) are intentionally not consulted here.
        BoundGlobalScope scope = compilation.GlobalScope;

        renderer = new GsStubRenderer();
        return renderer.RenderStub(scope);
    }
}
