// <copyright file="GsToCSharpProjection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Binding
import System

/// ADR-0145 §B facade: binds a G# (cref:Compilation)'s global scope and
/// renders the declaration-only C# stub the generator host feeds to Roslyn.
///
/// <b>Tolerance rule (ADR-0145 §B).</b> Projection reads only the global-scope
/// symbol tables — never `BindProgram` — so it deliberately ignores
/// global-scope diagnostics (unresolved references in bodies/initializers do not
/// abort). Only the symbol declarations are consumed.
shared class GsToCSharpProjection {
    /// Projects the user-declared types of [`compilation`](paramref) to a
    /// single declaration-only C# stub compilation unit.
    /// @param compilation The G# compilation to project.
    /// @returns A C# compilation-unit string prefixed with `#nullable enable`.
    func ProjectToCSharp(compilation Compilation) string {
        return ProjectToCSharp(compilation, out _)
    }

    /// Projects the user-declared types of [`compilation`](paramref) to a
    /// single declaration-only C# stub compilation unit, exposing the renderer
    /// so callers can inspect type-spelling fallbacks (`GS9204`) and notes.
    /// @param compilation The G# compilation to project.
    /// @param renderer The renderer that produced the stub, for fallback/note inspection.
    /// @returns A C# compilation-unit string prefixed with `#nullable enable`.
    func ProjectToCSharp(compilation Compilation, out renderer GsStubRenderer) string {
        ArgumentNullException.ThrowIfNull(compilation, paramName: "compilation")
        // Binding the global scope resolves declaration signatures and
        // attributes. Its diagnostics (which include not-yet-generated body
        // references) are intentionally not consulted here.
        let scope_ = compilation.GlobalScope
        renderer = GsStubRenderer()
        return renderer.RenderStub(scope_)
    }
}
