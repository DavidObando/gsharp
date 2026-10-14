// <copyright file="AccessibilityMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System.Reflection

/// PR-E-12: canonical home for the small G# (cref:Accessibility) →
/// (cref:System.Reflection) attribute mappers used by both
/// (cref:ReflectionMetadataEmitter) (root) and
/// (cref:TypeDefEmitter). Previously each sibling carried a private
/// copy to avoid widening the root's visibility; now both call into this
/// shared static helper.
internal shared class AccessibilityMap {
    func MapTypeAccessibility(accessibility Accessibility) TypeAttributes {
        return switch accessibility {
            case Accessibility.Internal: TypeAttributes.NotPublic
            case Accessibility.Private: TypeAttributes.NotPublic
            default: TypeAttributes.Public
        }
    }

    func MapNestedTypeAccessibility(accessibility Accessibility) TypeAttributes {
        return switch accessibility {
            case Accessibility.Internal: TypeAttributes.NestedAssembly
            case Accessibility.Private: TypeAttributes.NestedPrivate
            case Accessibility.Protected: TypeAttributes.NestedFamily
            default: TypeAttributes.NestedPublic
        }
    }

    func MapFieldAccessibility(accessibility Accessibility) FieldAttributes {
        return switch accessibility {
            case Accessibility.Internal: FieldAttributes.Assembly
            case Accessibility.Private: FieldAttributes.Private
            case Accessibility.Protected: FieldAttributes.Family
            default: FieldAttributes.Public
        }
    }

    func ToMethodVisibility(accessibility Accessibility) MethodAttributes {
        switch accessibility {
            case Accessibility.Public {
                return MethodAttributes.Public
            }
            case Accessibility.Internal {
                return MethodAttributes.Assembly
            }
            case Accessibility.Private {
                return MethodAttributes.Private
            }
            case Accessibility.Protected {
                return MethodAttributes.Family
            }
            default {
                return MethodAttributes.Public
            }
        }
    }

    /// Issue #909 / ADR-0109: maps a function's source accessibility to IL
    /// (cref:MethodAttributes) visibility, accounting for whether the
    /// function is a top-level member of the synthetic `<Program>`
    /// type.
    ///
    /// Top-level `private` functions live on `<Program>`, but the
    /// binder's accessibility model treats them as assembly-visible: sibling
    /// top-level types (e.g. a user `class`) in the same assembly may call
    /// them. Mapping source `private` to IL (cref:MethodAttributes.Private)
    /// makes the CLR enforce private-to-`<Program>`, which DISAGREES
    /// with the binder and yields a runtime (cref:System.MethodAccessException)
    /// despite a clean compile. We therefore emit top-level `private` as IL
    /// `assembly` (internal) so the IL accessibility matches what the binder
    /// already permits.
    ///
    /// This remapping is scoped to `<Program>` members ONLY. A
    /// `private` member of a user-defined `class`/`struct`/
    /// `interface` keeps IL (cref:MethodAttributes.Private) so the
    /// CLR continues to enforce real user-type privacy.
    /// @param accessibility The source accessibility of the function.
    /// @param isTopLevelProgramMember `true` when the function is hosted on the synthetic
    /// `<Program>` type (see (cref:IsTopLevelProgramMember)).
    /// @returns The IL visibility (cref:MethodAttributes).
    func ToMethodVisibility(accessibility Accessibility, isTopLevelProgramMember bool) MethodAttributes {
        if isTopLevelProgramMember && accessibility == Accessibility.Private {
            return MethodAttributes.Assembly
        }
        return ToMethodVisibility(accessibility)
    }

    /// Determines whether [`function`](paramref) is emitted as a top-level
    /// member of the synthetic `<Program>` type (as opposed to a
    /// member of a user-defined type). Instance methods are owned by their
    /// declaring type and static methods carry a non-null
    /// (cref:FunctionSymbol.StaticOwnerType); everything else (plain
    /// top-level functions, extension functions, and non-capturing lambda host
    /// methods) is hosted on `<Program>`.
    /// @param function The function being emitted.
    /// @returns `true` when the function is a `<Program>` member.
    func IsTopLevelProgramMember(function FunctionSymbol) bool -> !function.IsInstanceMethod &&
        function.StaticOwnerType == nil
}
