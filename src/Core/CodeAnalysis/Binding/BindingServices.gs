// <copyright file="BindingServices.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection

/// State that is keyed by the binding pass (the reference set, the imports and
/// the referencing syntax tree) and not by one body (ADR-0203 section 4,
/// issue #5140).
/// @remarks One instance lives on the root (cref:BoundScope) of a binding pass and is
/// reached through (cref:BoundScope.GetBindingServices). Every (cref:Binder) built
/// over that scope chain, one per body, shares it, so a view computed for one body is
/// reused by the next body with the same key instead of being rebuilt per body.
///
/// Each cache keeps exactly one entry and the same validation key that it had when it
/// lived on the per-body (cref:BinderContext): a different key recomputes the entry, so
/// a body never sees an import view built for another file or another import list.
/// Nothing here is enumerated in hash order. An independent-body worker scope owns
/// its own instance (see (cref:BoundScope.CreateIndependentBodyScope)) and never
/// touches the coordinator's. Only one thread binds against a given root scope.
internal class BindingServices {
    /// Gets or sets the imported static `[Extension]` classes for instance-syntax
    /// extension-method dispatch (issue #294). Recomputed when any of the
    /// `CachedImportedExtension*` validation fields falls out of step.
    var CachedImportedExtensionClasses List[Type]?

    /// Gets or sets the import count of the entry in (cref:CachedImportedExtensionClasses).
    /// It starts at `-1` so the first lookup always misses.
    var CachedImportedExtensionImportCount int32 = -1

    var CachedImportedExtensionSyntaxTree SyntaxTree?
    var CachedImportedExtensionReferences ReferenceResolver?
    var CachedImportedExtensionAssemblyName string?
    var CachedImportedExtensionImports ImmutableArray[ImportSymbol]

    /// Gets or sets the per-method-name index over (cref:CachedImportedExtensionClasses).
    /// It is dropped whenever the class list is recomputed.
    var CachedImportedExtensionMethods Dictionary[string, ImmutableArray[MethodInfo]]?

    /// Issue #1201: the user-defined types brought into unqualified static-member scope
    /// by a non-alias type import, with the import sequence, canonical struct snapshot and
    /// referencing file that they were computed for.
    var CachedStaticImportTypes ImmutableArray[StructSymbol]

    var HasCachedStaticImportTypes bool
    var CachedStaticImportImports ImmutableArray[ImportSymbol]
    var CachedStaticImportStructs ImmutableArray[StructSymbol]
    var CachedStaticImportSyntaxTree SyntaxTree?
}
