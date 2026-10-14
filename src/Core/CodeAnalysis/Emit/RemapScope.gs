// <copyright file="RemapScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Runtime.CompilerServices

/// Issue #3163: the reified generic-remap scope identity that every Emit-layer
/// cache keyed on symbols and producing scope-sensitive metadata rows
/// (TypeSpec / MemberRef / MethodSpec) must carry in its key.
/// @remarks The same (cref:GSharp.Core.CodeAnalysis.Symbols.TypeParameterSymbol)
/// (or a symbol constructed over one) encodes to different
/// `ELEMENT_TYPE_VAR` / `ELEMENT_TYPE_MVAR` ordinals depending on
/// which remaps are active on (cref:GenericRemapState) — the
/// state-machine/nested/closure class remap (VAR) and the generic-promoted
/// lambda method remap (MVAR). A cache key that omits either scope reuses a
/// row whose signature blob encodes the <em>other</em> scope's ordinals,
/// producing an invalid assembly (`BadImageFormatException`): this shipped
/// as #2930/#3057 (constructor MemberRefs) and again as #3065 (MethodSpecs).
///
/// Discrimination is (cref:object.ReferenceEquals(object, object)) on
/// the remap dictionary objects: (cref:GenericRemapState.PushSmRemap) /
/// (cref:GenericRemapState.PushLambdaMethodRemap) install a distinct
/// dictionary object per reified class and per promoted lambda rather than
/// mutating a shared buffer, so object identity is the intended discriminator
/// (a stale identity fails safe: cache miss, recompute). Obtain the current
/// scope via (cref:GenericRemapState.CurrentScope) at the point of
/// key construction — never cache a (cref:RemapScope) across a
/// push/pop boundary.
///
/// The internal analyzer rule GSA0004
/// (`EmitCacheKeyRemapScopeAnalyzer`, ADR-0147) enforces the invariant:
/// any `Dictionary`/`ConcurrentDictionary` field or property in
/// this namespace whose key mentions a symbol type and whose value is a
/// scope-sensitive handle must include a (cref:RemapScope) in its key.
internal struct RemapScope : IEquatable[RemapScope] {
    private let classRemap object?
    private let methodRemap object?

    /// Initializes a new instance of the (cref:RemapScope) struct.
    /// Prefer (cref:GenericRemapState.CurrentScope); this constructor
    /// exists for that property and for tests.
    /// @param classRemap The active state-machine/nested/closure class remap (VAR channel), or `null`.
    /// @param methodRemap The active generic-promoted lambda method remap (MVAR channel), or `null`.
    internal init(classRemap object?, methodRemap object?) {
        this.classRemap = classRemap
        this.methodRemap = methodRemap
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Equals(other RemapScope) bool -> object.ReferenceEquals(this.classRemap, other.classRemap) &&
        object.ReferenceEquals(this.methodRemap, other.methodRemap)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Equals(obj object?) bool -> obj is RemapScope other && this.Equals(other)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetHashCode() int32 {
        let hash = if this.classRemap == nil {
            0
        } else {
            RuntimeHelpers.GetHashCode(this.classRemap)
        }
        let methodHash = if this.methodRemap == nil {
            0
        } else {
            RuntimeHelpers.GetHashCode(this.methodRemap)
        }
        return unchecked((hash * 31) + methodHash)
    }
}
