// <copyright file="AccessibilityChecker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #950 / issue #2044: bind-time accessibility checks for the
/// <c>protected</c> and <c>private</c> modifiers. A <c>protected</c> member is
/// accessible within its declaring type and within the bodies of types that
/// derive from the declaring type; a <c>private</c> member is accessible only
/// within its declaring top-level type's body (including nested types of that
/// type, but not derived types). Either is inaccessible from unrelated
/// external code (e.g. the synthetic <c>&lt;Program&gt;</c> host or a sibling
/// type).
/// <para>
/// Unlike <c>internal</c> — which G# leaves to the CLR to enforce at runtime
/// via the emitted IL accessibility — <c>protected</c>/<c>private</c> add a
/// compile-time check so that external access is reported as a clean
/// diagnostic (GS0379 / GS0472) rather than surfacing only as a runtime
/// <see cref="System.MethodAccessException"/>/<see cref="System.FieldAccessException"/>.
/// The emitted IL still carries the matching CIL accessibility, so the CLR
/// independently enforces the same rule.
/// </para>
/// </summary>
internal static class AccessibilityChecker
{
    /// <summary>
    /// Returns <see langword="true"/> when a member declared on
    /// <paramref name="declaringType"/> with the given
    /// <paramref name="accessibility"/> is accessible from the body of
    /// <paramref name="currentFunction"/>. <c>protected</c> and <c>private</c>
    /// are enforced here (issue #950 / issue #2044); every other accessibility
    /// (<c>public</c>/<c>internal</c>) is treated as accessible (G# defers
    /// <c>internal</c> enforcement to the CLR).
    /// </summary>
    /// <param name="accessibility">The accessed member's accessibility.</param>
    /// <param name="declaringType">The type that declares the member.</param>
    /// <param name="currentFunction">The function whose body contains the access (may be <see langword="null"/> for top-level code).</param>
    /// <returns><see langword="true"/> when the access is permitted.</returns>
    public static bool IsAccessible(
        Accessibility accessibility,
        TypeSymbol? declaringType,
        FunctionSymbol? currentFunction)
    {
        // A direct generic local cannot borrow a lexical access domain that
        // its emitted host cannot preserve. Keep source lookup lexical, but
        // apply the ordinary Program-host checks to every member reference.
        currentFunction = NormalizeAccessContext(currentFunction);

        if (declaringType is InterfaceSymbol declaringInterface)
        {
            if (accessibility != Accessibility.Protected
                && accessibility != Accessibility.Private)
            {
                return true;
            }

            var enclosingInterface = GetEnclosingInterface(currentFunction);
            if (accessibility == Accessibility.Private)
            {
                return SameDeclaringInterface(enclosingInterface, declaringInterface);
            }

            return enclosingInterface?.SelfAndAllBaseInterfaces()
                .Any(candidate => SameDeclaringInterface(candidate, declaringInterface))
                == true;
        }

        return IsAccessibleFromType(accessibility, declaringType as StructSymbol, GetEnclosingClass(currentFunction));
    }

    /// <summary>
    /// Issue #4453: the C# CS1540 receiver rule for <c>protected</c> instance
    /// members. Outside its declaring class, a derived class may reach a
    /// <c>protected</c> instance member only through a receiver whose static
    /// type is that derived class or a class derived from it, because a
    /// receiver typed as the base (or a sibling) may be an instance of some
    /// other subclass. The CLR enforces the same rule (ILVerify reports
    /// <c>MethodAccess</c>/<c>FieldAccess</c>).
    /// <para>
    /// This reports only the receiver half: it returns <see langword="false"/>
    /// when <see cref="IsAccessible"/> already rejects the access, so the
    /// caller never reports the same access twice. Static members, which
    /// have no receiver, are exempt, as in C#.
    /// </para>
    /// </summary>
    /// <param name="accessibility">The accessed member's accessibility.</param>
    /// <param name="declaringType">The type that declares the member.</param>
    /// <param name="receiverType">The static type of the instance receiver, or <see langword="null"/> for a static member.</param>
    /// <param name="currentFunction">The function whose body contains the access.</param>
    /// <returns><see langword="true"/> when the access is reachable from the accessing class but not through this receiver.</returns>
    public static bool ViolatesProtectedReceiverRule(
        Accessibility accessibility,
        TypeSymbol? declaringType,
        TypeSymbol? receiverType,
        FunctionSymbol? currentFunction)
    {
        if (accessibility != Accessibility.Protected
            || receiverType == null
            || ReferenceEquals(receiverType, TypeSymbol.Error)
            || declaringType is not StructSymbol declaringClass
            || !IsAccessible(accessibility, declaringType, currentFunction))
        {
            return false;
        }

        var enclosingClass = GetEnclosingClass(NormalizeAccessContext(currentFunction));

        // Inside the declaring class itself, any receiver is fine: C# applies
        // the receiver rule only to access from a derived class.
        if (enclosingClass == null || SameClassDefinition(enclosingClass, declaringClass))
        {
            return false;
        }

        return !IsReceiverWithinClass(receiverType, enclosingClass);
    }

    /// <summary>
    /// Issue #4453: whether <paramref name="receiverType"/> is
    /// <paramref name="enclosingClass"/> or a class derived from it, any
    /// construction of a generic class counting as that class (C# allows
    /// <c>Derived&lt;int&gt;</c> inside <c>Derived&lt;T&gt;</c>). A
    /// nullability wrapper is read through, and a type parameter stands for
    /// its class constraint. The protected-receiver rule for both source
    /// members (<see cref="ViolatesProtectedReceiverRule"/>) and imported
    /// events (#4394) asks this one question.
    /// </summary>
    /// <param name="receiverType">The receiver's static type.</param>
    /// <param name="enclosingClass">The class containing the access.</param>
    /// <returns><see langword="true"/> when the receiver is of the enclosing class or a subclass.</returns>
    public static bool IsReceiverWithinClass(TypeSymbol receiverType, StructSymbol enclosingClass)
    {
        if (GetReceiverClass(receiverType) is not { } receiverClass)
        {
            return false;
        }

        foreach (var level in receiverClass.GetHierarchy())
        {
            if (SameClassDefinition(level, enclosingClass))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Returns whether a member or nested type is accessible from an enclosing
    /// source type when no function symbol exists yet.
    /// </summary>
    /// <param name="accessibility">The accessed member or nested type's accessibility.</param>
    /// <param name="declaringType">The type that declares the member or nested type.</param>
    /// <param name="enclosingType">The source type containing the access.</param>
    /// <returns><see langword="true"/> when the access is permitted.</returns>
    public static bool IsAccessibleFromType(
        Accessibility accessibility,
        StructSymbol? declaringType,
        StructSymbol? enclosingType)
    {
        if (declaringType == null || (accessibility != Accessibility.Protected && accessibility != Accessibility.Private))
        {
            return true;
        }

        if (accessibility == Accessibility.Private)
        {
            // Issue #2044: `private` is not inherited by derived types (unlike
            // `protected`), but it IS visible throughout the enclosing
            // top-level type's body, including its nested types — mirroring
            // C#'s "private members are accessible anywhere within the
            // containing type" rule. Compare top-level containers rather than
            // walking the base-class chain.
            return SameDeclaringType(GetTopLevelContainer(enclosingType), GetTopLevelContainer(declaringType));
        }

        // Issue #4164: this used to walk `.BaseClass` directly with no cycle
        // guard. Most callers are reached only after the post-bind cycle
        // detector (#973) has already broken any cyclic BaseClass link, but
        // at least one (BoundScope.TryLookupNestedTypeAliasIncludingInherited,
        // fixed for its own outer walk by #4164) can reach this defensively
        // before that point. `enclosingType.GetHierarchy()` is the single
        // guarded walk (fixed by #4162), so this can no longer diverge
        // regardless of caller.
        if (enclosingType == null)
        {
            return false;
        }

        foreach (var t in enclosingType.GetHierarchy())
        {
            if (SameDeclaringType(t, declaringType))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Resolves read accessibility for binder pseudo-variables that represent
    /// implicit instance/static fields or properties.
    /// </summary>
    /// <param name="variable">Potential implicit-member pseudo-variable.</param>
    /// <param name="currentFunction">Function containing the bare read/call.</param>
    /// <param name="declaringType">Actual member owner.</param>
    /// <param name="memberName">Underlying field/property name.</param>
    /// <param name="accessibility">Field or getter accessibility.</param>
    /// <returns>Whether the pseudo-variable denotes an inaccessible member read.</returns>
    public static bool TryGetInaccessibleImplicitMemberRead(
        VariableSymbol variable,
        FunctionSymbol? currentFunction,
        out TypeSymbol? declaringType,
        out string memberName,
        out Accessibility accessibility)
    {
        declaringType = null;
        memberName = variable.Name;
        accessibility = Accessibility.Public;
        switch (variable)
        {
            // Field-like event backing fields are injected into derived scopes
            // specifically so the declaring/derived type can raise the event.
            // Subscription accessibility belongs to the EventSymbol path.
            case ImplicitFieldVariableSymbol eventField
                when eventField.Field.IsEventBackingField:
            case ImplicitStaticFieldVariableSymbol staticEventField
                when staticEventField.Field.IsEventBackingField:
                return false;
            case ImplicitFieldVariableSymbol instanceField:
                declaringType = instanceField.StructType;
                memberName = instanceField.Field.Name;
                accessibility = instanceField.Field.Accessibility;
                break;
            case ImplicitStaticFieldVariableSymbol staticField:
                declaringType = (TypeSymbol?)staticField.StructType
                    ?? staticField.InterfaceType?.Definition
                    ?? staticField.InterfaceType;
                memberName = staticField.Field.Name;
                accessibility = staticField.Field.Accessibility;
                break;
            case ImplicitPropertyVariableSymbol instanceProperty:
                declaringType = instanceProperty.StructType;
                memberName = instanceProperty.Property.Name;
                accessibility = instanceProperty.Property.GetterAccessibility;
                break;
            case ImplicitStaticPropertyVariableSymbol staticProperty:
                declaringType = staticProperty.StructType;
                memberName = staticProperty.Property.Name;
                accessibility = staticProperty.Property.GetterAccessibility;
                break;
            default:
                return false;
        }

        return !IsAccessible(accessibility, declaringType, currentFunction);
    }

    /// <summary>
    /// Issue #4453: whether two classes are the same generic definition. Any
    /// construction counts as its definition, but, unlike
    /// <see cref="SameDeclaringType"/>, there is no fallback on the simple
    /// name and package: two nested classes <c>A.D</c> and <c>B.D</c> share
    /// both and are still different classes, and the receiver rule must not
    /// confuse them.
    /// </summary>
    private static bool SameClassDefinition(StructSymbol left, StructSymbol right)
    {
        var leftDefinition = left.Definition;
        var rightDefinition = right.Definition;
        return ReferenceEquals(leftDefinition, rightDefinition)
            || (leftDefinition.Declaration != null
                && ReferenceEquals(leftDefinition.Declaration, rightDefinition.Declaration));
    }

    /// <summary>
    /// The class a receiver of <paramref name="type"/> is statically known to
    /// be an instance of: the type itself, the type under a <c>?</c> or
    /// <c>!</c> wrapper (this asks which class, not whether it may be nil),
    /// or a type parameter's class constraint.
    /// </summary>
    private static StructSymbol? GetReceiverClass(TypeSymbol type)
    {
        // A malformed constraint cycle (`T U`, `U T`) must not hang the
        // binder; each type parameter is followed at most once.
        HashSet<TypeParameterSymbol>? visited = null;
        TypeSymbol? current = type;
        while (current != null)
        {
            switch (current)
            {
                case StructSymbol structType:
                    return structType;
                case NullableTypeSymbol nullable:
                    current = nullable.UnderlyingType;
                    break;
                case PlatformTypeSymbol platform:
                    current = platform.UnderlyingType;
                    break;
                case TypeParameterSymbol typeParameter:
                    visited ??= new HashSet<TypeParameterSymbol>(ReferenceEqualityComparer.Instance);
                    if (!visited.Add(typeParameter))
                    {
                        return null;
                    }

                    current = typeParameter.ClassConstraint ?? typeParameter.TypeParameterBound;
                    break;
                default:
                    return null;
            }
        }

        return null;
    }

    /// <summary>
    /// A direct generic local cannot borrow a lexical access domain that its
    /// emitted host cannot preserve, so it is checked as Program-host code.
    /// </summary>
    private static FunctionSymbol? NormalizeAccessContext(FunctionSymbol? currentFunction)
        => currentFunction?.LocalDeclaration != null && !currentFunction.HasNonGenericLexicalOwner
            ? null
            : currentFunction;

    private static StructSymbol? GetEnclosingClass(FunctionSymbol? currentFunction)
        => (currentFunction?.ReceiverType as StructSymbol)
            ?? (currentFunction?.StaticOwnerType as StructSymbol)
            ?? (currentFunction?.LexicalEnclosingType as StructSymbol);

    /// <summary>
    /// Issue #2044: walks <see cref="Symbol.ContainingType"/> to the
    /// outermost enclosing type, so nested types declared inside the same
    /// top-level type share `private` access to each other's members.
    /// </summary>
    private static StructSymbol? GetTopLevelContainer(StructSymbol? type)
    {
        var current = type;
        while (current?.ContainingType is StructSymbol parent)
        {
            current = parent;
        }

        return current;
    }

    private static bool SameDeclaringType(StructSymbol? a, StructSymbol? b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        // Symbols are normally canonical (one instance per declared type), but
        // guard against constructed/projected duplicates by comparing the
        // declaration identity and qualified name as a fallback.
        if (a.Declaration != null && ReferenceEquals(a.Declaration, b.Declaration))
        {
            return true;
        }

        return string.Equals(a.Name, b.Name, System.StringComparison.Ordinal)
            && string.Equals(a.PackageName, b.PackageName, System.StringComparison.Ordinal);
    }

    private static InterfaceSymbol? GetEnclosingInterface(FunctionSymbol? function)
    {
        var candidates = new[]
        {
            function?.ReceiverType,
            function?.StaticOwnerType,
            function?.LexicalEnclosingType,
        };
        foreach (var candidate in candidates)
        {
            for (var current = candidate; current != null; current = current.ContainingType)
            {
                if (current is InterfaceSymbol iface)
                {
                    return iface;
                }
            }
        }

        return null;
    }

    private static bool SameDeclaringInterface(InterfaceSymbol? left, InterfaceSymbol? right)
    {
        if (left == null || right == null)
        {
            return false;
        }

        var leftDefinition = left.Definition ?? left;
        var rightDefinition = right.Definition ?? right;
        return ReferenceEquals(leftDefinition, rightDefinition)
            || ReferenceEquals(leftDefinition.Declaration, rightDefinition.Declaration)
            || (string.Equals(
                    leftDefinition.Name,
                    rightDefinition.Name,
                    System.StringComparison.Ordinal)
                && string.Equals(
                    leftDefinition.PackageName,
                    rightDefinition.PackageName,
                    System.StringComparison.Ordinal));
    }
}
