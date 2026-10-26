// <copyright file="AccessibilityChecker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Linq

/// Issue #950 / issue #2044: bind-time accessibility checks for the
/// `protected` and `private` modifiers. A `protected` member is
/// accessible within its declaring type and within the bodies of types that
/// derive from the declaring type; a `private` member is accessible only
/// within its declaring top-level type's body (including nested types of that
/// type, but not derived types). Either is inaccessible from unrelated
/// external code (e.g. the synthetic `<Program>` host or a sibling
/// type).
///
/// Unlike `internal` — which G# leaves to the CLR to enforce at runtime
/// via the emitted IL accessibility — `protected`/`private` add a
/// compile-time check so that external access is reported as a clean
/// diagnostic (GS0379 / GS0472) rather than surfacing only as a runtime
/// (cref:System.MethodAccessException)/(cref:System.FieldAccessException).
/// The emitted IL still carries the matching CIL accessibility, so the CLR
/// independently enforces the same rule.
internal shared class AccessibilityChecker {
    /// Returns `true` when a member declared on
    /// [`declaringType`](paramref) with the given
    /// [`accessibility`](paramref) is accessible from the body of
    /// [`currentFunction`](paramref). `protected` and `private`
    /// are enforced here (issue #950 / issue #2044); every other accessibility
    /// (`public`/`internal`) is treated as accessible (G# defers
    /// `internal` enforcement to the CLR).
    /// @param accessibility The accessed member's accessibility.
    /// @param declaringType The type that declares the member.
    /// @param currentFunction The function whose body contains the access (may be `null` for top-level
    /// code).
    /// @returns `true` when the access is permitted.
    func IsAccessible(accessibility Accessibility, declaringType TypeSymbol?, currentFunction FunctionSymbol?) bool {
        var currentFunction = currentFunction
        // A direct generic local cannot borrow a lexical access domain that
        // its emitted host cannot preserve. Keep source lookup lexical, but
        // apply the ordinary Program-host checks to every member reference.
        currentFunction = NormalizeAccessContext(currentFunction)
        if declaringType is InterfaceSymbol declaringInterface {
            if accessibility != Accessibility.Protected && accessibility != Accessibility.Private {
                return true
            }
            let enclosingInterface = GetEnclosingInterface(currentFunction)
            if accessibility == Accessibility.Private {
                return SameDeclaringInterface(enclosingInterface, declaringInterface)
            }
            return enclosingInterface?.SelfAndAllBaseInterfaces().Any(
                (candidate InterfaceSymbol) -> SameDeclaringInterface(candidate, declaringInterface)
            ) == true
        }
        return IsAccessibleFromType(accessibility, declaringType as StructSymbol, GetEnclosingClass(currentFunction))
    }

    /// Issue #4453: the C# CS1540 receiver rule for `protected` instance
    /// members. Outside its declaring class, a derived class may reach a
    /// `protected` instance member only through a receiver whose static
    /// type is that derived class or a class derived from it, because a
    /// receiver typed as the base (or a sibling) may be an instance of some
    /// other subclass. The CLR enforces the same rule (ILVerify reports
    /// `MethodAccess`/`FieldAccess`).
    ///
    /// This reports only the receiver half: it returns `false`
    /// when (cref:IsAccessible) already rejects the access, so the
    /// caller never reports the same access twice. Static members, which
    /// have no receiver, are exempt, as in C#.
    /// @param accessibility The accessed member's accessibility.
    /// @param declaringType The type that declares the member.
    /// @param receiverType The static type of the instance receiver, or `null` for a static member.
    /// @param currentFunction The function whose body contains the access.
    /// @returns `true` when the access is reachable from the accessing class but not through this receiver.
    func ViolatesProtectedReceiverRule(
        accessibility Accessibility,
        declaringType TypeSymbol?,
        receiverType TypeSymbol?,
        currentFunction FunctionSymbol?
    ) bool {
        if accessibility != Accessibility.Protected || receiverType == nil || object.ReferenceEquals(
            receiverType,
            TypeSymbol.Error
        ) ||
            declaringType is not StructSymbol declaringClass ||
            !IsAccessible(accessibility, declaringType, currentFunction) {
            return false
        }
        let enclosingClass StructSymbol? = GetEnclosingClass(NormalizeAccessContext(currentFunction))
        // Inside the declaring class itself, any receiver is fine: C# applies
        // the receiver rule only to access from a derived class.
        if enclosingClass == nil || SameClassDefinition(enclosingClass, declaringClass) {
            return false
        }
        return !IsReceiverWithinClass(receiverType, enclosingClass)
    }

    /// Issue #4453: whether [`receiverType`](paramref) is
    /// [`enclosingClass`](paramref) or a class derived from it, any
    /// construction of a generic class counting as that class (C# allows
    /// `Derived<int>` inside `Derived<T>`). A
    /// nullability wrapper is read through, and a type parameter stands for
    /// its class constraint. The protected-receiver rule for both source
    /// members ((cref:ViolatesProtectedReceiverRule)) and imported
    /// events (#4394) asks this one question.
    /// @param receiverType The receiver's static type.
    /// @param enclosingClass The class containing the access.
    /// @returns `true` when the receiver is of the enclosing class or a subclass.
    func IsReceiverWithinClass(receiverType TypeSymbol, enclosingClass StructSymbol) bool {
        if GetReceiverClass(receiverType) is not{} receiverClass {
            return false
        }
        for level in receiverClass.GetHierarchy() {
            if SameClassDefinition(level, enclosingClass) {
                return true
            }
        }
        return false
    }

    /// Returns whether a member or nested type is accessible from an enclosing
    /// source type when no function symbol exists yet.
    /// @param accessibility The accessed member or nested type's accessibility.
    /// @param declaringType The type that declares the member or nested type.
    /// @param enclosingType The source type containing the access.
    /// @returns `true` when the access is permitted.
    func IsAccessibleFromType(
        accessibility Accessibility,
        declaringType StructSymbol?,
        enclosingType StructSymbol?
    ) bool {
        if declaringType == nil ||
            (accessibility != Accessibility.Protected && accessibility != Accessibility.Private) {
            return true
        }
        if accessibility == Accessibility.Private {
            // Issue #2044: `private` is not inherited by derived types (unlike
            // `protected`), but it IS visible throughout the enclosing
            // top-level type's body, including its nested types — mirroring
            // C#'s "private members are accessible anywhere within the
            // containing type" rule. Compare top-level containers rather than
            // walking the base-class chain.
            return SameDeclaringType(GetTopLevelContainer(enclosingType), GetTopLevelContainer(declaringType))
        }
        // Issue #4164: this used to walk `.BaseClass` directly with no cycle
        // guard. Most callers are reached only after the post-bind cycle
        // detector (#973) has already broken any cyclic BaseClass link, but
        // at least one (BoundScope.TryLookupNestedTypeAliasIncludingInherited,
        // fixed for its own outer walk by #4164) can reach this defensively
        // before that point. `enclosingType.GetHierarchy()` is the single
        // guarded walk (fixed by #4162), so this can no longer diverge
        // regardless of caller.
        if enclosingType == nil {
            return false
        }
        for t in enclosingType.GetHierarchy() {
            if SameDeclaringType(t, declaringType) {
                return true
            }
        }
        return false
    }

    /// Resolves read accessibility for binder pseudo-variables that represent
    /// implicit instance/static fields or properties.
    /// @param variable Potential implicit-member pseudo-variable.
    /// @param currentFunction Function containing the bare read/call.
    /// @param declaringType Actual member owner.
    /// @param memberName Underlying field/property name.
    /// @param accessibility Field or getter accessibility.
    /// @returns Whether the pseudo-variable denotes an inaccessible member read.
    func TryGetInaccessibleImplicitMemberRead(
        variable VariableSymbol,
        currentFunction FunctionSymbol?,
        out declaringType TypeSymbol?,
        out memberName string,
        out accessibility Accessibility
    ) bool {
        declaringType = nil
        memberName = variable.Name
        accessibility = Accessibility.Public
        switch variable {
            case eventField is ImplicitFieldVariableSymbol when eventField.Field.IsEventBackingField {
                return false
            }
            case staticEventField is ImplicitStaticFieldVariableSymbol when staticEventField.Field.IsEventBackingField {
                return false
            }
            case instanceField is ImplicitFieldVariableSymbol {
                declaringType = instanceField.StructType
                memberName = instanceField.Field.Name
                accessibility = instanceField.Field.Accessibility
            }
            case staticField is ImplicitStaticFieldVariableSymbol {
                declaringType = cast[TypeSymbol?](staticField.StructType) ??
                    staticField
                    .InterfaceType
                    ?.Definition ??
                    staticField.InterfaceType
                memberName = staticField.Field.Name
                accessibility = staticField.Field.Accessibility
            }
            case instanceProperty is ImplicitPropertyVariableSymbol {
                declaringType = instanceProperty.StructType
                memberName = instanceProperty.Property.Name
                accessibility = instanceProperty.Property.GetterAccessibility
            }
            case staticProperty is ImplicitStaticPropertyVariableSymbol {
                declaringType = staticProperty.StructType
                memberName = staticProperty.Property.Name
                accessibility = staticProperty.Property.GetterAccessibility
            }
            default {
                return false
            }
        }
        return !IsAccessible(accessibility, declaringType, currentFunction)
    }

    /// Issue #4453: whether two classes are the same generic definition. Any
    /// construction counts as its definition, but, unlike
    /// (cref:SameDeclaringType), there is no fallback on the simple
    /// name and package: two nested classes `A.D` and `B.D` share
    /// both and are still different classes, and the receiver rule must not
    /// confuse them.
    private func SameClassDefinition(left StructSymbol, right StructSymbol) bool {
        let leftDefinition = left.Definition
        let rightDefinition = right.Definition
        return object.ReferenceEquals(leftDefinition, rightDefinition) ||
            (
            leftDefinition!!.Declaration != nil && object.ReferenceEquals(
                leftDefinition!!.Declaration,
                rightDefinition!!.Declaration
            )
        )
    }

    /// The class a receiver of [`type`](paramref) is statically known to
    /// be an instance of: the type itself, the type under a `?` or
    /// `!` wrapper (this asks which class, not whether it may be nil),
    /// or a type parameter's class constraint.
    private func GetReceiverClass(type TypeSymbol) StructSymbol? {
        // A malformed constraint cycle (`T U`, `U T`) must not hang the
        // binder; each type parameter is followed at most once.
        var visited HashSet[TypeParameterSymbol]? = nil
        var current TypeSymbol? = type
        while current != nil {
            switch current {
                case structType is StructSymbol {
                    return structType
                }
                case nullable is NullableTypeSymbol {
                    current = nullable.UnderlyingType
                }
                case platform is PlatformTypeSymbol {
                    current = platform.UnderlyingType
                }
                case typeParameter is TypeParameterSymbol {
                    visited ??= HashSet[TypeParameterSymbol](ReferenceEqualityComparer.Instance)
                    if !visited!!.Add(typeParameter) {
                        return nil
                    }
                    current = typeParameter.ClassConstraint ?? typeParameter.TypeParameterBound
                }
                default {
                    return nil
                }
            }
        }
        return nil
    }

    /// A direct generic local cannot borrow a lexical access domain that its
    /// emitted host cannot preserve, so it is checked as Program-host code.
    private func NormalizeAccessContext(
        currentFunction FunctionSymbol?
    ) FunctionSymbol? -> if currentFunction?.LocalDeclaration != nil &&
        !currentFunction!!.HasNonGenericLexicalOwner {
        default(FunctionSymbol?)
    } else {
        currentFunction
    }

    private func GetEnclosingClass(currentFunction FunctionSymbol?) StructSymbol? {
        let candidates = []TypeSymbol? {
            currentFunction?.ReceiverType,
            currentFunction?.StaticOwnerType,
            currentFunction?.LexicalEnclosingType
        }
        for candidate in candidates {
            for var current TypeSymbol? = candidate; current != nil; current = current!!.ContainingType {
                if current is StructSymbol enclosingClass {
                    return enclosingClass
                }
            }
        }
        return nil
    }

    /// Issue #2044: walks (cref:Symbol.ContainingType) to the
    /// outermost enclosing type, so nested types declared inside the same
    /// top-level type share `private` access to each other's members.
    private func GetTopLevelContainer(type StructSymbol?) StructSymbol? {
        var container = type
        for var current TypeSymbol? = type?.ContainingType; current != nil; current = current!!.ContainingType {
            if current is StructSymbol parent {
                container = parent
            }
        }
        return container
    }

    private func SameDeclaringType(a StructSymbol?, b StructSymbol?) bool {
        if object.ReferenceEquals(a, b) {
            return true
        }
        if a == nil || b == nil {
            return false
        }
        // Symbols are normally canonical (one instance per declared type), but
        // guard against constructed/projected duplicates by comparing the
        // declaration identity and qualified name as a fallback.
        if a.Declaration != nil && object.ReferenceEquals(a.Declaration, b.Declaration) {
            return true
        }
        return string.Equals(a.Name, b.Name, StringComparison.Ordinal) && string.Equals(
            a.PackageName,
            b.PackageName,
            StringComparison.Ordinal
        )
    }

    private func GetEnclosingInterface(function FunctionSymbol?) InterfaceSymbol? {
        let candidates = []TypeSymbol? {
            function?.ReceiverType,
            function?.StaticOwnerType,
            function?.LexicalEnclosingType
        }
        for candidate in candidates {
            for var current TypeSymbol? = candidate; current != nil; current = current!!.ContainingType {
                if current is InterfaceSymbol iface {
                    return iface
                }
            }
        }
        return nil
    }

    private func SameDeclaringInterface(left InterfaceSymbol?, right InterfaceSymbol?) bool {
        if left == nil || right == nil {
            return false
        }
        let leftDefinition = left.Definition ?? left
        let rightDefinition = right.Definition ?? right
        return object.ReferenceEquals(leftDefinition, rightDefinition) || object.ReferenceEquals(
            leftDefinition.Declaration,
            rightDefinition.Declaration
        ) ||
            (
            string.Equals(leftDefinition.Name, rightDefinition.Name, StringComparison.Ordinal) && string.Equals(
                leftDefinition.PackageName,
                rightDefinition.PackageName,
                StringComparison.Ordinal
            )
        )
    }
}
