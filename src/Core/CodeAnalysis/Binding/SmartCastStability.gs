// <copyright file="SmartCastStability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// ADR-0069 addendum / issue #1180: the Kotlin-parity stability rules that
/// decide whether a member-access chain may participate in smart-cast flow
/// narrowing. A narrowing on a member path is only sound when every link is
/// guaranteed not to change between the test and the use — i.e. an immutable
/// member (no settable setter, no custom getter, not overridable) declared in
/// the current compilation, read through a stable receiver chain.
internal shared class SmartCastStability {
    /// Returns whether [`variable`](paramref) can root a stable access
    /// path. Mirrors the receiver-stability rule of ADR-0069's switch addendum:
    /// locals and parameters (including the synthetic `this` receiver) and
    /// read-only top-level `let` globals. Mutable globals are excluded —
    /// they may be reassigned between the test and the use.
    /// @param variable The candidate root variable.
    /// @returns `true` when the variable is a stable root.
    func IsStableRoot(variable VariableSymbol) bool {
        return switch variable {
            case _ is LocalVariableSymbol: true
            case g is GlobalVariableSymbol: g.IsReadOnly
            default: false
        }
    }

    /// Returns whether assignment flow can track [`variable`](paramref)
    /// by exact symbol identity. Plain locals (including captured locals and
    /// value parameters) and top-level globals qualify. By-reference locals
    /// and parameters are excluded because another alias may mutate their
    /// storage; fields and properties use member-path invalidation instead.
    /// @param variable The candidate assignment target.
    /// @returns `true` when assignment flow can track the variable.
    func IsAssignmentNarrowingRoot(variable VariableSymbol) bool {
        return switch variable {
            case local is LocalVariableSymbol: local.RefKind == RefKind.None
            case _ is GlobalVariableSymbol: true
            default: false
        }
    }

    /// Returns whether [`field`](paramref) is an immutable instance field
    /// (declared with `let`, hence emitted `initonly`, or a `const`)
    /// that may appear as a stable link. A `var` field is excluded.
    /// @param field The field read in the chain.
    /// @returns `true` when the field is a stable link.
    func IsStableField(field FieldSymbol?) bool {
        return field != nil && field.IsReadOnly && !field.IsStatic
    }

    /// Returns whether [`property`](paramref) is a stable link. Following
    /// Kotlin, this requires an auto-property (no custom getter, so the read is
    /// idempotent), that is effectively immutable (no setter, or an
    /// `init`-only setter that cannot run after construction), and that is
    /// not overridable (neither `open`/virtual nor an override — an
    /// override could change the observed value through dynamic dispatch).
    /// @param property The property read in the chain.
    /// @returns `true` when the property is a stable link.
    func IsStableProperty(property PropertySymbol?) bool {
        return property != nil &&
            property.HasGetter &&
            property.IsAutoProperty &&
            !property.IsVirtual &&
            !property.IsOverride &&
            !property.IsStatic &&
            (!property.HasSetter || property.IsInitOnly)
    }

    /// Attempts to derive the stable (cref:AccessPath) that
    /// [`expr`](paramref) reads. Returns `null` unless the whole chain
    /// is stable: a stable root variable optionally followed by immutable
    /// field / property links read through stable receivers. Imported read-only
    /// fields and get-only auto-properties are stable too. Mutable members,
    /// computed properties, indexers, and method results are never stable.
    /// @param expr The candidate access expression.
    /// @returns The stable access path, or `null`.
    func TryGetStablePath(expr BoundExpression) AccessPath? {
        switch expr {
            case bve is BoundVariableExpression when IsStableRoot(bve.Variable) {
                return AccessPath.ForVariable(bve.Variable)
            }
            case fa is BoundFieldAccessExpression when fa.Receiver != nil &&
                fa.InterfaceType == nil &&
                IsStableField(fa.Field) {
                {
                    let parent = TryGetStablePath(fa.Receiver!!)
                    return parent?.Append(fa.Field)
                }
            }
            case pa is BoundPropertyAccessExpression when pa.Receiver != nil && IsStableProperty(pa.Property) {
                {
                    let parent = TryGetStablePath(pa.Receiver!!)
                    return parent?.Append(pa.Property)
                }
            }
            case ca is BoundClrPropertyAccessExpression when ca.Receiver != nil && IsStableClrMember(ca.Member) {
                {
                    let parent = TryGetStablePath(ca.Receiver!!)
                    return parent?.Append(ca.Member)
                }
            }
            default {
                return nil
            }
        }
    }

    /// Attempts to derive a stable <em>member</em> access path (a path with at
    /// least one member link) for [`expr`](paramref), together with the
    /// expression's current (pre-narrowing) static type. Returns `false`
    /// for plain variables (handled by the existing variable-narrowing path) and
    /// for any unstable chain.
    /// @param expr The candidate access expression.
    /// @param path The resulting stable member path, when successful.
    /// @param currentType The current static type of the read.
    /// @returns `true` when a stable member path was derived.
    func TryGetStableMemberPath(
        expr BoundExpression,
        @NotNullWhen(true) out path AccessPath?,
        @NotNullWhen(true) out currentType TypeSymbol?
    ) bool {
        path = TryGetStablePath(expr)
        if path != nil && path.HasMembers {
            currentType = expr.Type
            return true
        }
        path = nil
        currentType = nil
        return false
    }

    /// ADR-0069 addendum / issues #700/#712/#1180/#1545: recognises the leaf
    /// nil-guard comparison (`x == nil` / `x != nil`) where the
    /// non-nil operand is a stable, narrowable target of (cref:NullableTypeSymbol) type. The target may be
    /// a bare local or
    /// parameter, or a stable immutable member path. This is the single shared
    /// leaf used by BOTH the if-condition classifier
    /// (`StatementBinder.TryClassifyNilGuard`) and the short-circuit
    /// operand classifier (`ExpressionBinder.ClassifyTypeTestNarrowing`)
    /// so the two nil-guard classifiers stay consistent.
    /// @param condition The candidate comparison expression.
    /// @param restrictBareVariableToLocalsAndParams When `true`, a bare variable target is only accepted
    /// when it is a
    /// local or parameter, matching the soundness restriction the type-test
    /// (`x is T`) short-circuit classifier applies — a mutable global could
    /// be reassigned by a side effect between the guard and the use across
    /// `&&`/`||`. When `false` (the if-statement
    /// classifier, which has flow-based mutation invalidation), any variable is
    /// accepted. Stable member paths are always subject to their own
    /// stable-root rules regardless of this flag.
    /// @param referenceNullableOnly When `true` (the `&&`/`||` short-circuit
    /// classifier), a nullable VALUE type (e.g. `int32?`) is rejected
    /// because narrowing it to its non-nullable form is not an IL no-op and the
    /// variable-load path does not emit the required unwrap (issue #1545). When
    /// `false` (the if-statement classifier), value-type nullables are
    /// accepted, preserving that path's pre-existing behaviour.
    /// @param target The narrowed access path, when successful.
    /// @param underlying The non-nullable underlying type to narrow to.
    /// @param nonNilWhenTrue `true` for `x != nil` (the target is non-nil when the
    /// comparison is true); `false` for `x == nil` (the target is
    /// non-nil when the comparison is false).
    /// @returns `true` when a nil-guard leaf was recognised.
    func TryClassifyNilGuardLeaf(
        condition BoundExpression,
        restrictBareVariableToLocalsAndParams bool,
        referenceNullableOnly bool,
        @NotNullWhen(true) out target AccessPath?,
        @NotNullWhen(true) out underlying TypeSymbol?,
        out nonNilWhenTrue bool
    ) bool {
        target = nil
        underlying = nil
        nonNilWhenTrue = false
        let UnwrapFlowTransparentConversions = func (expression BoundExpression) BoundExpression {
            var expression = expression
            while expression is BoundConversionExpression conversion && StatementBinder.IsFlowTransparentConversion(
                conversion
            ) {
                expression = conversion.Expression
            }
            return expression
        }
        if condition is not BoundBinaryOperationExpression be {
            return false
        }
        if be.BinaryOperatorKind is not(BoundBinaryOperatorKind.Equals or BoundBinaryOperatorKind.NotEquals) {
            return false
        }
        let left = UnwrapFlowTransparentConversions(be.Left)
        let right = UnwrapFlowTransparentConversions(be.Right)
        var targetType TypeSymbol? = nil
        if left is BoundVariableExpression lv &&
            IsAcceptableBareVariable(lv.Variable, restrictBareVariableToLocalsAndParams) &&
            StatementBinder.IsNilLiteral(right) {
            target = lv.Variable
            targetType = lv.Variable.Type
        } else if right is BoundVariableExpression rv &&
            IsAcceptableBareVariable(rv.Variable, restrictBareVariableToLocalsAndParams) &&
            StatementBinder.IsNilLiteral(left) {
            target = rv.Variable
            targetType = rv.Variable.Type
        } else if StatementBinder.IsNilLiteral(right) &&
            TryGetStableMemberPath(left, out var leftPath, out var leftType) {
            target = leftPath
            targetType = MemberLookup.GetDeclaredAccessPathType(leftPath!!, leftType!!)
        } else if StatementBinder.IsNilLiteral(left) &&
            TryGetStableMemberPath(right, out var rightPath, out var rightType) {
            target = rightPath
            targetType = MemberLookup.GetDeclaredAccessPathType(rightPath!!, rightType!!)
        }
        // ADR-0186 §6: a nil guard narrows a PLATFORM value exactly as it
        // narrows a nullable one — "inside `if x != nil { … }`, `x` has type
        // `T`". Without this arm the classifier rejected `T!` outright, so
        // §6's narrowing claim was simply false for platform values and §4's
        // check was never elided after a guard.
        //
        // It is also the safest possible narrowing: a platform wrapper shares
        // its underlying's CLR type by construction (§1), and §2 excludes
        // value types from the category entirely, so there is no
        // storage-versus-narrowed-type divergence of the kind the value-type
        // guard below exists for. Narrowing here is an IL no-op.
        let narrowedUnderlying TypeSymbol? = switch targetType {
            case nullableTarget is NullableTypeSymbol: nullableTarget.UnderlyingType
            case platformTarget is PlatformTypeSymbol: platformTarget.UnderlyingType
            default: default(TypeSymbol?)
        }
        if target == nil || narrowedUnderlying == nil {
            target = nil
            return false
        }
        // User-defined equality may report true or false independently of
        // reference nullness. String equality is the only CLR-operator shape
        // whose nil comparison is a language-level null guard.
        if be is BoundClrBinaryOperatorExpression && narrowedUnderlying != TypeSymbol.String {
            target = nil
            return false
        }
        // Issue #1545: narrowing a nullable VALUE type (`int32?` → `int32`)
        // requires an unwrap the variable-load path does not currently emit, so
        // the narrowed static type and the `System.Nullable<T>` storage diverge
        // and the method fails ilverify (a pre-existing latent gap; see the
        // separately-tracked value-type nil-narrowing emit bug). For a nullable
        // REFERENCE type the narrowed type and its storage are the same CLR type,
        // so narrowing is an IL no-op and is safe. The short-circuit
        // (`&&`/`||`) caller passes `referenceNullableOnly: true` to stay on the
        // safe side; the statement classifier keeps its pre-existing behaviour.
        // Issue #1572: a user-declared value-type nullable (struct? / enum?)
        // has the same storage-vs-narrowed-type divergence, but a null ClrType,
        // so include the symbol-aware predicate here too.
        if referenceNullableOnly &&
            targetType is NullableTypeSymbol nullable &&
            (NullableLifting.IsValueTypeNullable(nullable) || NullableLifting.IsUserValueTypeNullable(nullable)) {
            target = nil
            return false
        }
        underlying = narrowedUnderlying
        nonNilWhenTrue = be.BinaryOperatorKind == BoundBinaryOperatorKind.NotEquals
        return true
    }

    /// Decides whether an `is`-type-test of an operand whose static type is
    /// [`declared`](paramref) against [`candidate`](paramref) should
    /// smart-cast (narrow) the operand to [`candidate`](paramref) in the
    /// then-branch. Shared by the statement (`if x is T`) and short-circuit
    /// (`x is T && …`) narrowing classifiers so both agree.
    ///
    /// [`candidate`](paramref) must already have any nullable wrapper
    /// stripped by the caller.
    /// @param declared The operand's declared (static) type.
    /// @param candidate The tested type (nullable wrapper stripped).
    /// @returns `true` when the test narrows the operand to [`candidate`](paramref).
    func IsTypeTestNarrowing(declared TypeSymbol, candidate TypeSymbol?) bool {
        if candidate == nil || candidate == TypeSymbol.Error {
            return false
        }
        if declared == candidate {
            return false
        }
        // Stripping the nullable wrapper alone counts as narrowing
        // (`string? → string`).
        if declared is NullableTypeSymbol declaredNullable && declaredNullable.UnderlyingType == candidate {
            return true
        }
        // Issue #1636: a candidate distinct from the declared type is a genuine
        // subtype narrowing when it implicitly converts to the declared type
        // (candidate → declared): every candidate value is already usable as
        // declared. Structural projection constructs a new value and therefore
        // is not a runtime subtype relation; exclude it from type-test narrowing.
        let toDeclared = Conversion.ClassifyNonStructural(candidate, declared)
        if toDeclared.Exists && toDeclared.IsImplicit {
            return true
        }
        // Issue #2165: when the operand's static type is a TYPE PARAMETER or an
        // INTERFACE, the runtime value may implement additional, statically-
        // unrelated interfaces. Testing such an operand against an interface is
        // therefore meaningful, so narrow to the tested interface even though it
        // does not implicitly convert back to the declared type — matching the
        // Kotlin-parity behaviour already applied to `object`/concrete-class
        // operands. Excluded: a widening to a base interface the declared type
        // already satisfies (declared → candidate), which would only hide the
        // declared type's own members without adding any.
        // Issue #2171: a NULLABLE type-parameter (`T?`) or nullable interface
        // (`IShape?`) operand behaves identically for this rule — the nullable
        // wrapper does not change which interfaces the runtime value may
        // implement — so strip it before applying the type-parameter/interface
        // test.
        // Issue #3526: a CONCRETE CLASS operand that can have subclasses is
        // the same story — a runtime value may be a subclass (known or not)
        // that implements an interface the declared class does not statically
        // implement. `object` already narrowed via the candidate->declared
        // branch above (every reference type converts to `object`); an
        // `open` class or an ADR-0078 `sealed` (closed-hierarchy) class needs
        // the same treatment here — `Conversion.IsSealedReferenceType`
        // mirrors TypeDefEmitter's actual CLR-sealing condition, so only a
        // plain, non-`open`/non-`sealed` (truly CLR-sealed, no-subclass)
        // class is excluded — matching the checked-cast eligibility rule in
        // Conversion.HasCheckedReferenceConversion.
        let declaredCore = if declared is NullableTypeSymbol declaredNullableCore {
            declaredNullableCore.UnderlyingType
        } else {
            declared
        }
        if IsInterfaceType(candidate) &&
            (
            declaredCore is TypeParameterSymbol ||
                IsInterfaceType(declaredCore) ||
                (Conversion.IsClassLikeReferenceType(declaredCore) && !Conversion.IsSealedReferenceType(declaredCore))
        ) {
            let toCandidate = Conversion.Classify(declaredCore, candidate)
            if !(toCandidate.Exists && toCandidate.IsImplicit) {
                return true
            }
        }
        return false
    }

    private func IsStableClrMember(member MemberInfo) bool {
        if member is FieldInfo field {
            return !field.IsStatic && field.IsInitOnly
        }
        if member is not PropertyInfo property || property.GetIndexParameters().Length != 0 || property.GetGetMethod(
            nonPublic: false
        ) is not MethodInfo getter ||
            getter.IsStatic ||
            getter.IsVirtual ||
            property.GetSetMethod(nonPublic: true) != nil {
            return false
        }
        let backingField = ClrTypeUtilities.SafeGetField(
            property.DeclaringType,
            "<${property.Name}>k__BackingField",
            BindingFlags.Instance | BindingFlags.NonPublic
        )
        return backingField?.IsInitOnly == true
    }

    private func IsAcceptableBareVariable(variable VariableSymbol, restrictToLocalsAndParams bool) bool {
        // ParameterSymbol derives from LocalVariableSymbol and is covered here.
        return !restrictToLocalsAndParams || variable is LocalVariableSymbol
    }

    private func IsInterfaceType(type TypeSymbol) bool -> type is InterfaceSymbol ||
        (type?.ClrType is Type clr && clr.IsInterface)
}
